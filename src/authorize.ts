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
}

// houseCode = tb_house.house_code ของเจ้าของ credential (null = ไม่มีบ้าน เช่น Visitor งานส่วนกลาง)
type Identity = { subject: Subject; credentialId?: string; houseCode: string | null } | { reason: string };

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

// ค่าเดียวกันนี้ต้องใช้ตอนลงทะเบียน credential ใน tb_credential.cred_hash
export const credentialHash = (pepper: string, projectId: string, credType: CredType, value: string) =>
	hmacHex(pepper, `${projectId}:${credType}:${value}`);

// Guest Code "9801+1234" -> "98011234" ตัด + * # ช่องว่าง - ที่ Keypad / QR อาจส่งมา
export function guestDigits(value: string): string | null {
	const digits = value.replace(/[+*#\s-]/g, "");
	return /^\d{5,10}$/.test(digits) ? digits : null;
}

// houseCode จาก SEMA ใช้ตรวจซ้ำเท่านั้น: credential ต้องเป็นของบ้านนั้น ไม่ใช้ตัดสินสิทธิ์
export async function decide(env: Env, projectId: string, method: Method, value: string, houseCode?: string): Promise<Decision> {
	const who =
		method === "ANPR"
			? await identifyPlate(env.DB, projectId, normalizePlate(value))
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
	return { ...base, decision: "YES", reason_code: YES_REASON[who.subject] };
}

async function identifyPlate(db: D1Database, projectId: string, plate: string): Promise<Identity> {
	const blacklisted = await db
		.prepare("SELECT 1 FROM tb_blacklist WHERE project_id = ? AND license_plate = ? AND is_active = 1 LIMIT 1")
		.bind(projectId, plate)
		.first();
	if (blacklisted) return { reason: "BLACKLISTED" };

	const resident = await db
		.prepare(
			`SELECT h.payment_status, h.house_code, h.is_active AS house_active FROM tb_vehicle v
			 JOIN tb_user u ON u.user_id = v.user_id
			 LEFT JOIN tb_house h ON h.house_id = u.house_id
			 WHERE v.project_id = ? AND v.license_plate = ? AND v.is_active = 1 AND u.is_active = 1
			 LIMIT 1`,
		)
		.bind(projectId, plate)
		.first<{ payment_status: string | null; house_code: string | null; house_active: number | null }>();
	// บ้านที่ปิดใช้งาน = ลูกบ้านทุกคนในบ้านนั้นเข้าไม่ได้
	if (resident?.house_active === 0) return { reason: "USER_INACTIVE" };
	if (resident) return { subject: residentSubject(resident.payment_status), houseCode: resident.house_code };

	const visitor = await db
		.prepare(
			`SELECT h.house_code FROM tb_visitor v
			 LEFT JOIN tb_house h ON h.house_id = v.house_id
			 WHERE v.project_id = ? AND v.license_plate = ? AND v.is_active = 1 AND (v.house_id IS NULL OR h.is_active = 1)
			   AND datetime('now') BETWEEN datetime(v.valid_from) AND datetime(v.valid_until)
			 LIMIT 1`,
		)
		.bind(projectId, plate)
		.first<{ house_code: string | null }>();
	if (visitor) return { subject: "VISITOR", houseCode: visitor.house_code };

	return { reason: "UNKNOWN_PLATE" };
}

interface CredentialRow {
	credential_id: string;
	user_id: string | null;
	is_active: number;
	id_status: string;
	max_uses: number | null;
	use_count: number;
	started: number;
	not_expired: number;
	user_active: number | null;
	house_active: number | null;
	payment_status: string | null;
	house_code: string | null;
	visitor_valid: number;
}

const findCredential = async (env: Env, projectId: string, credType: CredType, value: string) =>
	env.DB.prepare(
		`SELECT c.credential_id, c.user_id, c.is_active, c.id_status, c.max_uses, c.use_count,
		   (c.valid_from IS NULL OR datetime(c.valid_from) <= datetime('now')) AS started,
		   (c.valid_until IS NULL OR datetime(c.valid_until) >= datetime('now')) AS not_expired,
		   u.is_active AS user_active, COALESCE(h.is_active, vh.is_active) AS house_active, h.payment_status, COALESCE(h.house_code, vh.house_code) AS house_code,
		   (vis.is_active = 1 AND datetime('now') BETWEEN datetime(vis.valid_from) AND datetime(vis.valid_until)) AS visitor_valid
		 FROM tb_credential c
		 LEFT JOIN tb_user u ON u.user_id = c.user_id
		 LEFT JOIN tb_house h ON h.house_id = u.house_id
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

	if (c.user_id) {
		if (c.user_active !== 1 || c.house_active === 0) return { reason: "USER_INACTIVE" };
		return { subject: residentSubject(c.payment_status), credentialId: c.credential_id, houseCode: c.house_code };
	}
	if (!c.visitor_valid || c.house_active === 0) return { reason: "VISITOR_NOT_VALID" };
	return { subject: "VISITOR", credentialId: c.credential_id, houseCode: c.house_code };
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
