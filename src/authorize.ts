import { hmacHex } from "./crypto";

export const METHODS = ["ANPR", "RFID", "QRCODE", "PIN"] as const;
export type Method = (typeof METHODS)[number];
// GUEST = Guest Code ของผู้เยี่ยมชม ใช้ได้ทั้ง QRCODE และ PIN (Keypad) ด้วยเลขเดียวกัน
export type CredType = Method | "GUEST";
export type Subject = "RESIDENT" | "RESIDENT_OVERDUE" | "RESIDENT_OVERDUE_SEVERE" | "VISITOR";

export interface Decision {
	decision: "YES" | "NO" | "ERROR";
	reason_code: string;
	allowed_methods: Method[];
	subject?: Subject;
	credential_ref?: string;
	// บ้านเลขที่ของเจ้าของ input ส่งเฉพาะ YES (null = Visitor งานส่วนกลาง)
	house_number?: string | null;
}

// houseCode = tb_house.house_code ของเจ้าของ credential (null = ไม่มีบ้าน เช่น Visitor งานส่วนกลาง)
type Identity = { subject: Subject; credentialId?: string; houseCode: string | null; houseNumber: string | null } | { reason: string };

const YES_REASON: Record<Subject, string> = {
	RESIDENT: "RESIDENT_ACTIVE",
	RESIDENT_OVERDUE: "RESIDENT_OVERDUE_ALLOWED",
	RESIDENT_OVERDUE_SEVERE: "RESIDENT_OVERDUE_ALLOWED",
	VISITOR: "VISITOR_VALID",
};

// tb_house.payment_status -> กลุ่มใน tb_policy
const residentSubject = (paymentStatus: string | null): Subject =>
	paymentStatus === "OVERDUE_SEVERE" ? "RESIDENT_OVERDUE_SEVERE" : paymentStatus === "OVERDUE" ? "RESIDENT_OVERDUE" : "RESIDENT";

// ทะเบียนที่เก็บใน tb_vehicle / tb_visitor / tb_blacklist ต้อง normalize แบบเดียวกัน
export const normalizePlate = (plate: string) => plate.replace(/[\s-]/g, "").toUpperCase();
// ทะเบียนที่ลงทะเบียนได้ (หลัง normalizePlate): หมวด (1กข / กข / รวย) + เลข 1-4 หลัก หรือรถบรรทุก / รถโดยสาร 2 + 4 หลัก
// (ถ้ายอมเลข 2 หลักนำหน้าทุกความยาว เลขล้วนอย่าง "1234" จะผ่าน)
export const PLATE_RE = /^(\d?[ก-ฮ]{1,3}\d{1,4}|\d{6})$/;

// ป้ายไทยซ้ำกันได้ข้ามจังหวัด: เก็บ/เทียบจังหวัดแบบตัดช่องว่าง และรวมชื่อย่อของกรุงเทพฯ
const PROVINCE_ALIASES: Record<string, string> = { กทม: "กรุงเทพมหานคร", "กทม.": "กรุงเทพมหานคร", กรุงเทพ: "กรุงเทพมหานคร", กรุงเทพฯ: "กรุงเทพมหานคร" };
// ป้ายทะเบียนไทยเป็นภาษาไทย: จังหวัดต้องเป็นตัวอักษรไทย (หลังตัดช่องว่าง / แปลงชื่อย่อ)
export const isThaiProvince = (p: string) => /^[ก-๙]+$/.test(p);

export const normalizeProvince = (province: string | undefined | null) => {
	const p = province?.replace(/\s/g, "");
	return p ? (PROVINCE_ALIASES[p] ?? p) : null;
};

// ค่าเดียวกันนี้ต้องใช้ตอนลงทะเบียน credential ใน tb_credential.cred_hash
export const credentialHash = (pepper: string, projectId: string, credType: CredType, value: string) =>
	hmacHex(pepper, `${projectId}:${credType}:${value}`);

// Guest Code "9801+1234" -> "98011234" ตัด + * # ช่องว่าง - ที่ Keypad / QR อาจส่งมา
export function guestDigits(value: string): string | null {
	const digits = value.replace(/[+*#\s-]/g, "");
	return /^\d{5,10}$/.test(digits) ? digits : null;
}

// houseCode จาก SEMA ใช้ตรวจซ้ำเท่านั้น: credential ต้องเป็นของบ้านนั้น ไม่ใช้ตัดสินสิทธิ์
export async function decide(env: Env, projectId: string, method: Method, value: string, houseCode?: string, province?: string): Promise<Decision> {
	const who =
		method === "ANPR"
			? await identifyPlate(env.DB, projectId, normalizePlate(value), normalizeProvince(province))
			: await identifyCredential(env, projectId, method, value);
	if ("reason" in who) return { decision: "NO", reason_code: who.reason, allowed_methods: [] };
	if (houseCode !== undefined && who.houseCode !== houseCode) return { decision: "NO", reason_code: "HOUSE_MISMATCH", allowed_methods: [] };

	const allowed = await allowedMethods(env.DB, projectId, who.subject);
	const base = { subject: who.subject, allowed_methods: allowed, credential_ref: who.credentialId };
	if (!allowed.includes(method)) {
		const reason = who.subject.startsWith("RESIDENT_OVERDUE") ? who.subject : "METHOD_NOT_ALLOWED";
		return { ...base, decision: "NO", reason_code: reason };
	}
	if (who.credentialId && !(await consumeCredential(env.DB, who.credentialId))) {
		return { ...base, decision: "NO", reason_code: "CREDENTIAL_USED_UP" };
	}
	return { ...base, decision: "YES", reason_code: YES_REASON[who.subject], house_number: who.houseNumber };
}

async function identifyPlate(db: D1Database, projectId: string, plate: string, province: string | null): Promise<Identity> {
	const blacklisted = await db
		.prepare("SELECT 1 FROM tb_blacklist WHERE project_id = ? AND license_plate = ? AND is_active = 1 LIMIT 1")
		.bind(projectId, plate)
		.first();
	if (blacklisted) return { reason: "BLACKLISTED" };

	const { results: residents } = await db
		.prepare(
			`SELECT v.province, h.payment_status, h.house_code, h.house_number, h.is_active AS house_active, h.occupancy_status
			 FROM tb_vehicle v JOIN tb_house h ON h.house_id = v.house_id
			 WHERE v.project_id = ? AND v.license_plate = ? AND v.is_active = 1`,
		)
		.bind(projectId, plate)
		.all<HouseRow & { province: string | null }>();
	// ป้ายเดียว = ใช้เลย (ไม่พึ่ง OCR จังหวัดที่อาจอ่านผิด); ป้ายซ้ำต่างจังหวัด = ใช้จังหวัดจากกล้องเลือก
	const resident = residents.length <= 1 ? residents[0] : residents.find((r) => province && r.province === province);
	if (residents.length > 1 && !resident) return { reason: "PLATE_AMBIGUOUS" };
	if (resident) return houseIdentity(resident);

	const visitor = await db
		.prepare(
			`SELECT h.house_code, h.house_number FROM tb_visitor v
			 LEFT JOIN tb_house h ON h.house_id = v.house_id
			 WHERE v.project_id = ? AND v.license_plate = ? AND v.is_active = 1
			   AND (v.house_id IS NULL OR (h.is_active = 1 AND COALESCE(h.occupancy_status, 'OCCUPIED') <> 'VACANT'))
			   AND datetime('now') BETWEEN datetime(v.valid_from) AND datetime(v.valid_until)
			 LIMIT 1`,
		)
		.bind(projectId, plate)
		.first<{ house_code: string | null; house_number: string | null }>();
	if (visitor) return { subject: "VISITOR", houseCode: visitor.house_code, houseNumber: visitor.house_number };

	return { reason: "UNKNOWN_PLATE" };
}

interface HouseRow {
	payment_status: string | null;
	house_code: string | null;
	house_number: string | null;
	house_active: number | null;
	occupancy_status: string | null;
}

// บ้านที่ปิดใช้งาน / ไม่มีผู้อยู่อาศัย = ทุกช่องทางของบ้านนั้นใช้ไม่ได้
function houseIdentity(h: HouseRow, credentialId?: string): Identity {
	if (h.house_active === 0) return { reason: "USER_INACTIVE" };
	if (h.occupancy_status === "VACANT") return { reason: "HOUSE_VACANT" };
	return { subject: residentSubject(h.payment_status), credentialId, houseCode: h.house_code, houseNumber: h.house_number };
}

interface CredentialRow extends HouseRow {
	credential_id: string;
	house_id: string | null;
	is_active: number;
	id_status: string;
	max_uses: number | null;
	use_count: number;
	started: number;
	not_expired: number;
	visitor_valid: number;
}

const findCredential = async (env: Env, projectId: string, credType: CredType, value: string) =>
	env.DB.prepare(
		`SELECT c.credential_id, c.house_id, c.is_active, c.id_status, c.max_uses, c.use_count,
		   (c.valid_from IS NULL OR datetime(c.valid_from) <= datetime('now')) AS started,
		   (c.valid_until IS NULL OR datetime(c.valid_until) >= datetime('now')) AS not_expired,
		   COALESCE(h.is_active, vh.is_active) AS house_active, h.payment_status, COALESCE(h.house_code, vh.house_code) AS house_code,
		   COALESCE(h.house_number, vh.house_number) AS house_number, COALESCE(h.occupancy_status, vh.occupancy_status) AS occupancy_status,
		   (vis.is_active = 1 AND datetime('now') BETWEEN datetime(vis.valid_from) AND datetime(vis.valid_until)) AS visitor_valid
		 FROM tb_credential c
		 LEFT JOIN tb_house h ON h.house_id = c.house_id
		 LEFT JOIN tb_visitor vis ON vis.visitor_id = c.visitor_id
		 LEFT JOIN tb_house vh ON vh.house_id = vis.house_id
		 WHERE c.project_id = ? AND c.cred_type = ? AND c.cred_hash = ?`,
	)
		.bind(projectId, credType, await credentialHash(env.CRED_PEPPER, projectId, credType, value))
		.first<CredentialRow>();

async function identifyCredential(env: Env, projectId: string, method: Method, value: string): Promise<Identity> {
	let c = await findCredential(env, projectId, method, value);
	const digits = !c && (method === "QRCODE" || method === "PIN") ? guestDigits(value) : null;
	if (digits) c = await findCredential(env, projectId, "GUEST", digits);

	if (!c) return { reason: "UNKNOWN_CREDENTIAL" };
	if (c.is_active !== 1 || c.id_status === "REVOKED") return { reason: "CREDENTIAL_REVOKED" };
	if (!c.started) return { reason: "CREDENTIAL_NOT_YET_VALID" };
	if (!c.not_expired) return { reason: "CREDENTIAL_EXPIRED" };
	if (c.max_uses !== null && c.use_count >= c.max_uses) return { reason: "CREDENTIAL_USED_UP" };

	if (c.house_id) return houseIdentity(c, c.credential_id);
	if (c.occupancy_status === "VACANT") return { reason: "HOUSE_VACANT" };
	if (!c.visitor_valid || c.house_active === 0) return { reason: "VISITOR_NOT_VALID" };
	return { subject: "VISITOR", credentialId: c.credential_id, houseCode: c.house_code, houseNumber: c.house_number };
}

async function allowedMethods(db: D1Database, projectId: string, subject: Subject): Promise<Method[]> {
	const { results } = await db
		.prepare("SELECT method FROM tb_policy WHERE project_id = ? AND subject_type = ? AND is_allowed = 1")
		.bind(projectId, subject)
		.all<{ method: string }>();
	const set = new Set(results.map((r) => r.method));
	return METHODS.filter((m) => set.has(m));
}

// เพิ่ม use_count แบบ atomic; คืน false เมื่อครบ max_uses ไปแล้ว (กันกรณีใช้พร้อมกัน)
async function consumeCredential(db: D1Database, credentialId: string): Promise<boolean> {
	const res = await db
		.prepare(
			"UPDATE tb_credential SET use_count = use_count + 1 WHERE credential_id = ? AND (max_uses IS NULL OR use_count < max_uses)",
		)
		.bind(credentialId)
		.run();
	// changes นับแถวที่ trigger update_date แก้ด้วย จึงใช้ > 0 ไม่ใช่ === 1
	return res.meta.changes > 0;
}
