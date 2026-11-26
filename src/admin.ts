import {
	addCredential as addHouseCredential,
	createHouseUser,
	credentialColumns,
	demoteOwner,
	HOUSE_ROLES,
	issueLinkCode,
	requireOccupiedHouse,
	revokeCredential as revokeHouseCredential,
	updateCredential as updateHouseCredential,
} from "./access";
import { auditTarget, writeAudit } from "./audit";
import { isImageKind, readEventImage, signedImageUrl } from "./images";
import { isThaiProvince, normalizePlate, normalizeProvince, PLATE_RE, type Method } from "./authorize";
import { hashPassword, JWT_ISS, sha256Hex, signJwt, verifyJwt, verifyPassword } from "./crypto";
import {
	COMMON_AREA_CODE_RE,
	DEFAULT_COMMON_AREA_CODE,
	HOUSE_CODE_RE,
	issueGuest,
	listVisitors,
	revokeVisitor,
	updateVisitor,
} from "./guest";
import {
	badField,
	type Body,
	errorResponse,
	HttpError,
	isStr,
	isUniqueViolation,
	json,
	notFound,
	optBool,
	optEnum,
	optStr,
	readJson,
	reqStr,
} from "./http";

const ADMIN_AUD = "aaa-admin";
const ADMIN_TTL_SEC = 60 * 60;
// ใช้เมื่อไม่พบ admin เพื่อให้เวลาตอบใกล้เคียงกรณีรหัสผิด
const DUMMY_HASH = `pbkdf2_sha256$100000$${"00".repeat(16)}$${"00".repeat(32)}`;

const PAYMENT_STATUSES = ["NORMAL", "OVERDUE", "OVERDUE_SEVERE"];
const ADMIN_CRED_TYPES: Method[] = ["RFID", "QRCODE", "PIN"];

interface Ctx {
	env: Env;
	adminId: string;
	level: string; // ROOT (PlayDevX, ทุกโครงการ) / ADMIN (ประจำโครงการ)
	pid: string; // project_id ที่กำลังจัดการ (ADMIN = ของตัวเอง, ROOT = ตาม X-Project-Code) ทุก query ต้องกรองด้วยค่านี้
	id: string;
	body: Body;
	url: URL;
}

function optActive(body: Body): number | undefined {
	const v = optBool(body, "is_active");
	return v === undefined ? undefined : v ? 1 : 0;
}

function optHouseCode(body: Body): string | null | undefined {
	const v = optStr(body, "house_code", 6);
	if (v && !HOUSE_CODE_RE.test(v)) throw badField("house_code");
	return v;
}

// table / column มาจากโค้ดเท่านั้น ห้ามรับจาก request
async function patchRow(c: Ctx, table: string, idCol: string, sets: Record<string, unknown>) {
	const cols = Object.keys(sets).filter((k) => sets[k] !== undefined);
	if (cols.length === 0) throw badField("body");
	const res = await c.env.DB.prepare(
		`UPDATE ${table} SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE ${idCol} = ? AND project_id = ?`,
	)
		.bind(...cols.map((k) => sets[k]), c.id, c.pid)
		.run();
	if (res.meta.changes === 0) throw notFound();
}

async function requireRow(c: Ctx, table: string, idCol: string, id: string) {
	const row = await c.env.DB.prepare(`SELECT 1 FROM ${table} WHERE ${idCol} = ? AND project_id = ?`).bind(id, c.pid).first();
	if (!row) throw notFound();
}

// ---------- Houses ----------
// สิทธิ์เข้าออก (รถ / RFID / PIN / QR) เป็นของบ้าน; tb_user = ผู้ติดต่อของบ้าน + บัญชี LINE

const HOUSE_COLS = "house_id, house_number, house_code, zone_or_soi, payment_status, occupancy_status, is_active, update_date";
const OCCUPANCY = ["OCCUPIED", "VACANT"];
const CONTACT_COLS = "user_id, ref, house_id, full_name, phone_number, role, line_user_id IS NOT NULL AS line_linked";
// เจ้าบ้านขึ้นก่อน (= ผู้ติดต่อหลัก) แล้วตามลำดับที่เพิ่ม
const CONTACT_ORDER = "CASE role WHEN 'OWNER' THEN 0 ELSE 1 END, autoID";

async function listHouses(c: Ctx) {
	const db = c.env.DB;
	const [houses, contacts] = await db.batch<Record<string, unknown>>([
		db.prepare(`SELECT ${HOUSE_COLS} FROM tb_house WHERE project_id = ? ORDER BY house_number`).bind(c.pid),
		db.prepare(`SELECT ${CONTACT_COLS} FROM tb_user WHERE project_id = ? AND is_active = 1 ORDER BY ${CONTACT_ORDER}`).bind(c.pid),
	]);
	const byHouse = new Map<unknown, unknown[]>();
	for (const ct of contacts.results) byHouse.set(ct.house_id, [...(byHouse.get(ct.house_id) ?? []), ct]);
	return json({ houses: houses.results.map((h) => ({ ...h, contacts: byHouse.get(h.house_id) ?? [] })) });
}

async function getHouse(c: Ctx) {
	const db = c.env.DB;
	const [house, contacts, vehicles, credentials] = await db.batch([
		db.prepare(`SELECT ${HOUSE_COLS} FROM tb_house WHERE house_id = ? AND project_id = ?`).bind(c.id, c.pid),
		db.prepare(`SELECT ${CONTACT_COLS} FROM tb_user WHERE house_id = ? AND project_id = ? AND is_active = 1 ORDER BY ${CONTACT_ORDER}`).bind(
			c.id,
			c.pid,
		),
		db.prepare(
			"SELECT vehicle_id, license_plate, province, brand, color, label, is_active FROM tb_vehicle WHERE house_id = ? AND project_id = ?",
		).bind(c.id, c.pid),
		// ห้ามคืน cred_hash
		db.prepare(
			`SELECT ${credentialColumns} FROM tb_credential WHERE house_id = ? AND project_id = ?`,
		).bind(c.id, c.pid),
	]);
	if (house.results.length === 0) throw notFound();
	return json({
		...(house.results[0] as Record<string, unknown>),
		contacts: contacts.results,
		vehicles: vehicles.results,
		credentials: credentials.results,
	});
}

async function createHouse(c: Ctx) {
	const houseId = crypto.randomUUID();
	await c.env.DB.prepare(
		"INSERT INTO tb_house (house_id, project_id, house_number, house_code, zone_or_soi, occupancy_status) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(
			houseId,
			c.pid,
			reqStr(c.body, "house_number", 32),
			optHouseCode(c.body) ?? null,
			optStr(c.body, "zone_or_soi", 64) ?? null,
			optEnum(c.body, "occupancy_status", OCCUPANCY) ?? "OCCUPIED",
		)
		.run();
	return json({ house_id: houseId }, 201);
}

async function updateHouse(c: Ctx) {
	await patchRow(c, "tb_house", "house_id", {
		house_number: c.body.house_number === undefined ? undefined : reqStr(c.body, "house_number", 32),
		house_code: optHouseCode(c.body),
		zone_or_soi: optStr(c.body, "zone_or_soi", 64),
		payment_status: optEnum(c.body, "payment_status", PAYMENT_STATUSES),
		occupancy_status: optEnum(c.body, "occupancy_status", OCCUPANCY),
		is_active: optActive(c.body),
	});
	return json({ house_id: c.id });
}

// ---------- Contacts (tb_user) ----------

// Admin สร้างคนในบ้านได้ทุกสถานะ (ปกติสร้างเจ้าบ้าน แล้วเจ้าบ้านเชิญคนอื่นเองผ่าน LINE)
async function addContact(c: Ctx) {
	return json(await createHouseUser(c.env, c.pid, c.id, c.body, HOUSE_ROLES, "OWNER"), 201);
}

// เปลี่ยนเป็นเจ้าบ้าน = เจ้าบ้านเดิมกลายเป็นผู้พักอาศัย (บัญชี LINE ของทั้งสองคนยังใช้ได้)
async function updateContact(c: Ctx) {
	const role = optEnum(c.body, "role", HOUSE_ROLES);
	if (role === "OWNER") {
		const u = await c.env.DB.prepare("SELECT house_id FROM tb_user WHERE user_id = ? AND project_id = ? AND is_active = 1")
			.bind(c.id, c.pid)
			.first<{ house_id: string | null }>();
		if (!u) throw notFound();
		if (u.house_id) await demoteOwner(c.env, u.house_id, c.id).run();
	}
	await patchRow(c, "tb_user", "user_id", {
		full_name: c.body.full_name === undefined ? undefined : reqStr(c.body, "full_name", 128),
		phone_number: optStr(c.body, "phone_number", 32),
		role,
	});
	return json({ user_id: c.id });
}

// Soft delete: audit / visitor ที่เขาออกยังอ้างอิงได้; บัญชี LINE ของเขาใช้ไม่ได้ทันที
async function removeContact(c: Ctx) {
	await patchRow(c, "tb_user", "user_id", { is_active: 0 });
	return json({ user_id: c.id, is_active: 0 });
}

// ---------- Vehicles ----------

// รถจาก body (ใช้ทั้งเพิ่มและแก้); exceptId = รถคันที่กำลังแก้ (ไม่นับว่าชนกับตัวเอง)
async function parseVehicle(c: Ctx, exceptId = "") {
	const plate = normalizePlate(reqStr(c.body, "license_plate", 32));
	// หมวด (1กข / กข / รวย / 70) + เลข 1-4 หลัก; จังหวัดอยู่อีกช่อง
	if (!PLATE_RE.test(plate)) throw badField("license_plate");
	const province = normalizeProvince(optStr(c.body, "province", 64));
	if (province && !isThaiProvince(province)) throw badField("province");
	// ป้ายเดียวกันต่างจังหวัด = คนละคัน; ไม่ระบุจังหวัด = ชนกับทุกจังหวัด
	const dup = await c.env.DB.prepare(
		`SELECT 1 FROM tb_vehicle WHERE project_id = ? AND license_plate = ? AND is_active = 1 AND vehicle_id <> ?
		   AND (? IS NULL OR province IS NULL OR province = ?)`,
	)
		.bind(c.pid, plate, exceptId, province, province)
		.first();
	if (dup) throw new HttpError(409, "PLATE_EXISTS", "license_plate");
	return {
		license_plate: plate,
		province,
		brand: optStr(c.body, "brand", 64) ?? null,
		color: optStr(c.body, "color", 32) ?? null,
		label: optStr(c.body, "label", 32) ?? null,
	};
}

async function addVehicle(c: Ctx) {
	await requireOccupiedHouse(c.env, c.pid, c.id);
	const v = await parseVehicle(c);

	const vehicleId = crypto.randomUUID();
	await c.env.DB.prepare(
		"INSERT INTO tb_vehicle (vehicle_id, project_id, house_id, license_plate, province, brand, color, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(vehicleId, c.pid, c.id, v.license_plate, v.province, v.brand, v.color, v.label)
		.run();
	return json({ vehicle_id: vehicleId, license_plate: v.license_plate }, 201);
}

// แก้รถทั้งคัน (ฟอร์มส่งครบทุกช่อง); เปลี่ยนทะเบียนแล้ว ANPR ใช้ทะเบียนใหม่ทันที
// label ไม่ส่ง = คงชื่อสั้นที่คนในบ้านตั้งไว้ (ชื่อสั้นเป็นหน้าที่ของคนในบ้าน)
async function updateVehicle(c: Ctx) {
	const v = await parseVehicle(c, c.id);
	const keepLabel = c.body.label === undefined;
	const res = await c.env.DB.prepare(
		`UPDATE tb_vehicle SET license_plate = ?, province = ?, brand = ?, color = ?${keepLabel ? "" : ", label = ?"}
		 WHERE vehicle_id = ? AND project_id = ? AND is_active = 1`,
	)
		.bind(v.license_plate, v.province, v.brand, v.color, ...(keepLabel ? [] : [v.label]), c.id, c.pid)
		.run();
	if (res.meta.changes === 0) throw notFound();
	return json({ vehicle_id: c.id, license_plate: v.license_plate });
}

async function removeVehicle(c: Ctx) {
	await patchRow(c, "tb_vehicle", "vehicle_id", { is_active: 0 });
	return json({ vehicle_id: c.id, is_active: 0 });
}

// ---------- Credentials ----------
// กติกา (PIN / QR = house_code นำหน้า, จำกัด 20 ชุด, label) อยู่ใน access.ts ใช้ร่วมกับ Owner API

async function addCredential(c: Ctx) {
	return json(await addHouseCredential(c.env, c.pid, c.id, { type: "ADMIN", id: c.adminId }, c.body, ADMIN_CRED_TYPES), 201);
}

// แก้ชื่อสั้น / ระยะเวลา (ตัวรหัสแก้ไม่ได้ เก็บเป็น hash)
async function updateCredential(c: Ctx) {
	await updateHouseCredential(c.env, c.pid, c.id, c.body);
	return json({ credential_id: c.id });
}

// Admin / Root ลบได้ทุกรายการในโครงการ
async function revokeCredential(c: Ctx) {
	await revokeHouseCredential(c.env, c.pid, c.id);
	return json({ credential_id: c.id, id_status: "REVOKED" });
}

// ---------- LINE link code ----------

// รหัสเชื่อม LINE ของคนในบ้าน (ปกติ = เจ้าบ้าน) ใช้ครั้งเดียว อายุ 24 ชม.
async function createLinkCode(c: Ctx) {
	return json(await issueLinkCode(c.env, sha256Hex, c.id, c.pid), 201);
}

// ---------- Visitors ----------

async function adminListVisitors(c: Ctx) {
	const houseId = c.url.searchParams.get("house_id") ?? undefined;
	const visitors = await listVisitors(c.env, c.pid, houseId, c.url.searchParams.get("valid") === "1");
	return json({ visitors });
}

// house_id ไม่ส่ง / null = ผู้เยี่ยมชมงานส่วนกลาง (Guest Code ขึ้นต้นด้วย 0)
async function adminCreateVisitor(c: Ctx) {
	const houseId = optStr(c.body, "house_id", 64) ?? null;
	// งานส่วนกลาง = รหัสพื้นที่ส่วนกลางของโครงการ (ค่าเริ่มต้น 0000)
	let prefix =
		(await c.env.DB.prepare("SELECT common_area_code FROM tb_project WHERE project_id = ?").bind(c.pid).first<string>("common_area_code")) ??
		DEFAULT_COMMON_AREA_CODE;
	if (houseId) {
		const house = await requireOccupiedHouse(c.env, c.pid, houseId);
		if (!house.house_code) throw new HttpError(409, "HOUSE_CODE_MISSING", "house_id");
		prefix = house.house_code;
	}
	const issueCode = optBool(c.body, "issue_code") ?? true;
	return json(await issueGuest(c.env, c.pid, { houseId, prefix, issuedBy: "ADMIN", issuedById: c.adminId, issueCode }, c.body), 201);
}

async function adminUpdateVisitor(c: Ctx) {
	await updateVisitor(c.env, c.pid, c.id, c.body);
	return json({ visitor_id: c.id });
}

async function adminRevokeVisitor(c: Ctx) {
	await revokeVisitor(c.env, c.pid, c.id);
	return json({ visitor_id: c.id, id_status: "REVOKED" });
}

// ---------- Access log ----------

// การเข้าออกของโครงการ ใหม่สุดก่อน (Dashboard / รายงาน); ไม่มีค่า PIN / QR (มีแค่ label ของรายการ)
// ?limit= 1-1000 (ค่าเริ่มต้น 20) &from= &to= (เวลา UTC แบบ SQLite / ISO) &decision=YES|NO|ERROR &method=ANPR|RFID|QRCODE|PIN
async function listAccessLogs(c: Ctx) {
	const q = c.url.searchParams;
	const limit = Math.min(Math.max(Math.trunc(Number(q.get("limit"))) || 20, 1), 1000);
	const where = ["l.project_id = ?"];
	const args: unknown[] = [c.pid];
	for (const [param, sql] of [
		["from", "datetime(l.timestamp) >= datetime(?)"],
		["to", "datetime(l.timestamp) <= datetime(?)"],
	] as const) {
		const v = q.get(param);
		if (!v) continue;
		if (Number.isNaN(Date.parse(v))) throw badField(param);
		where.push(sql);
		args.push(v.replace("T", " ").replace("Z", "").slice(0, 19));
	}
	for (const [param, allowed] of [
		["decision", ["YES", "NO", "ERROR"]],
		["method", ["ANPR", "RFID", "QRCODE", "PIN"]],
	] as const) {
		const v = q.get(param);
		if (!v) continue;
		if (!(allowed as readonly string[]).includes(v)) throw badField(param);
		where.push(`l.${param} = ?`);
		args.push(v);
	}
	const { results } = await c.env.DB.prepare(
		`SELECT l.log_id, l.timestamp, l.access_type, l.method, l.decision, l.reason_code, l.license_plate,
		   COALESCE(l.house_number, h.house_number) AS house_number, l.house_id, h.house_code, d.gate_name, cr.cred_type, cr.label AS credential_label,
		   l.image_url IS NOT NULL AS has_image, l.plate_image_key IS NOT NULL AS has_plate_image
		 FROM tb_access_log l
		 LEFT JOIN tb_device d ON d.device_id = l.device_id
		 LEFT JOIN tb_credential cr ON cr.credential_id = l.credential_ref
		 LEFT JOIN tb_house h ON h.house_id = l.house_id
		 WHERE ${where.join(" AND ")} ORDER BY l.timestamp DESC, l.autoID DESC LIMIT ?`,
	)
		.bind(...args, limit)
		.all<Record<string, unknown>>();
	// ?signed=1 (CSV ของรายงาน): ลิงก์ดูรูปที่หมดอายุใน 7 วัน เปิดได้โดยไม่ต้อง login
	if (q.get("signed") === "1") {
		for (const r of results) {
			const id = String(r.log_id);
			if (r.has_image) r.image_link = await signedImageUrl(c.env, c.url.origin, id, "scene");
			if (r.has_plate_image) r.plate_image_link = await signedImageUrl(c.env, c.url.origin, id, "plate");
		}
	}
	return json({ logs: results });
}

// รูปของ event (Admin เห็นเฉพาะโครงการตัวเอง) ?kind=scene|plate
async function accessLogImage(c: Ctx) {
	const kind = c.url.searchParams.get("kind") ?? "scene";
	if (!isImageKind(kind)) throw badField("kind");
	const res = await readEventImage(c.env, c.pid, c.id, kind);
	// ภาพเป็นข้อมูลส่วนบุคคล (PDPA): บันทึกทุกการดูภาพ
	if (res.ok) await writeAudit(c.env, c.pid, "ADMIN", c.adminId, "GET /api/v1/admin/access-logs/:id/image", c.id, { kind });
	return res;
}

// ---------- Root: โครงการ + Admin ----------

// policy ตั้งต้นของโครงการใหม่ (เหมือน AAASQL/seeds/default_policy.sql)
const DEFAULT_POLICY: [string, Method][] = [
	["RESIDENT", "ANPR"], ["RESIDENT", "RFID"], ["RESIDENT", "QRCODE"], ["RESIDENT", "PIN"],
	["RESIDENT_OVERDUE", "RFID"], ["RESIDENT_OVERDUE", "PIN"],
	["RESIDENT_OVERDUE_SEVERE", "PIN"],
	["VISITOR", "QRCODE"], ["VISITOR", "PIN"],
];

function requireRoot(c: Ctx) {
	if (c.level !== "ROOT") throw new HttpError(403, "FORBIDDEN");
}

async function listProjects(c: Ctx) {
	requireRoot(c);
	const { results } = await c.env.DB.prepare(
		`SELECT p.project_id, p.project_code, p.project_name, p.common_area_code, p.is_active,
		   (SELECT COUNT(*) FROM tb_house h WHERE h.project_id = p.project_id) AS houses,
		   (SELECT COUNT(*) FROM tb_admin a WHERE a.project_id = p.project_id AND a.is_active = 1) AS admins
		 FROM tb_project p ORDER BY p.project_code`,
	).all();
	return json({ projects: results });
}

// โครงการใหม่ + policy ตั้งต้น (ไม่มี policy = ปฏิเสธทุกคน)
async function createProject(c: Ctx) {
	requireRoot(c);
	const code = normalizeProjectCode(c.body.project_code);
	if (!code) throw badField("project_code");
	const common = optStr(c.body, "common_area_code", 6) ?? DEFAULT_COMMON_AREA_CODE;
	if (!COMMON_AREA_CODE_RE.test(common)) throw badField("common_area_code");
	const projectId = crypto.randomUUID();
	const db = c.env.DB;
	await db.batch([
		db.prepare("INSERT INTO tb_project (project_id, project_name, project_code, common_area_code) VALUES (?, ?, ?, ?)").bind(
			projectId,
			reqStr(c.body, "project_name", 128),
			code,
			common,
		),
		...DEFAULT_POLICY.map(([s, m]) =>
			db.prepare("INSERT INTO tb_policy (project_id, subject_type, method) VALUES (?, ?, ?)").bind(projectId, s, m),
		),
	]);
	return json({ project_id: projectId, project_code: code }, 201);
}

// ตั้งค่าโครงการ (master): ชื่อ + รหัสพื้นที่ส่วนกลาง; :id = project_code
async function updateProject(c: Ctx) {
	requireRoot(c);
	const code = normalizeProjectCode(c.id);
	const common = optStr(c.body, "common_area_code", 6);
	if (common !== undefined && (common === null || !COMMON_AREA_CODE_RE.test(common))) throw badField("common_area_code");
	const sets: Record<string, unknown> = {
		project_name: c.body.project_name === undefined ? undefined : reqStr(c.body, "project_name", 128),
		common_area_code: common,
	};
	const cols = Object.keys(sets).filter((k) => sets[k] !== undefined);
	if (!code || cols.length === 0) throw badField("body");
	const res = await c.env.DB.prepare(`UPDATE tb_project SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE project_code = ?`)
		.bind(...cols.map((k) => sets[k]), code)
		.run();
	if (res.meta.changes === 0) throw notFound();
	return json({ project_code: code });
}

async function listAdmins(c: Ctx) {
	requireRoot(c);
	const { results } = await c.env.DB.prepare(
		`SELECT a.admin_id, a.ref, a.admin_name, a.admin_level, a.is_active, p.project_code, p.project_name
		 FROM tb_admin a JOIN tb_project p ON p.project_id = a.project_id ORDER BY p.project_code, a.autoID`,
	).all();
	return json({ admins: results });
}

// Root สร้าง ADMIN ประจำโครงการ (Root เพิ่มด้วย SQL เท่านั้น); ref = <project_code>-ANN
async function createAdmin(c: Ctx) {
	requireRoot(c);
	const code = normalizeProjectCode(c.body.project_code);
	const project = code && (await c.env.DB.prepare("SELECT project_id FROM tb_project WHERE project_code = ?").bind(code).first<{ project_id: string }>());
	if (!project) throw badField("project_code");
	const adminName = reqStr(c.body, "admin_name", 128);
	const password = reqStr(c.body, "password", 256);
	if (password.length < 12) throw badField("password");
	const hash = await hashPassword(password);
	const count = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM tb_admin WHERE project_id = ? AND admin_level = 'ADMIN'").bind(project.project_id).first<number>("n")) ?? 0;
	const adminId = crypto.randomUUID();
	const ref = `${code}-A${String(count + 1).padStart(2, "0")}`;
	try {
		// รหัสที่ Root ตั้งให้ = ต้องเปลี่ยนตอน login ครั้งแรก
		await c.env.DB.prepare(
			"INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password, admin_level, ref, must_change_password) VALUES (?, ?, ?, ?, 'ADMIN', ?, 1)",
		)
			.bind(adminId, project.project_id, adminName, hash, ref)
			.run();
	} catch (err) {
		if (isUniqueViolation(err)) throw new HttpError(409, "ADMIN_EXISTS", "admin_name");
		throw err;
	}
	return json({ admin_id: adminId, ref }, 201);
}

// 16 ตัว ไม่มีตัวที่สับสนกัน (I l O 0 1)
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const randomPassword = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => PW_ALPHABET[b % PW_ALPHABET.length]).join("");

// ลืมรหัสผ่าน: Root ตั้งรหัสสุ่มให้ ADMIN (คืนครั้งเดียว) แล้ว ADMIN ต้องเปลี่ยนตอน login
async function resetAdminPassword(c: Ctx) {
	requireRoot(c);
	const password = randomPassword();
	const res = await c.env.DB.prepare(
		"UPDATE tb_admin SET admin_password = ?, must_change_password = 1 WHERE admin_id = ? AND admin_level = 'ADMIN' AND is_active = 1",
	)
		.bind(await hashPassword(password), c.id)
		.run();
	if (res.meta.changes === 0) throw notFound();
	return json({ admin_id: c.id, password });
}

// เปลี่ยนรหัสผ่านของตัวเอง (ทั้ง ROOT / ADMIN) ต้องรู้รหัสเดิม; รหัสใหม่ ≥ 12 ตัว และไม่ซ้ำรหัสเดิม
async function changeMyPassword(c: Ctx) {
	const current = reqStr(c.body, "current_password", 256);
	const next = reqStr(c.body, "new_password", 256);
	if (next.length < 12 || next === current) throw badField("new_password");
	const me = await getActiveAdmin(c.env, c.adminId);
	if (!me || !(await verifyPassword(current, me.admin_password))) throw new HttpError(400, "WRONG_PASSWORD", "current_password");
	await c.env.DB.prepare("UPDATE tb_admin SET admin_password = ?, must_change_password = 0 WHERE admin_id = ?")
		.bind(await hashPassword(next), c.adminId)
		.run();
	return json({ admin_id: c.adminId, must_change_password: 0 });
}

async function deactivateAdmin(c: Ctx) {
	requireRoot(c);
	const res = await c.env.DB.prepare("UPDATE tb_admin SET is_active = 0 WHERE admin_id = ? AND admin_level = 'ADMIN'").bind(c.id).run();
	if (res.meta.changes === 0) throw notFound();
	return json({ admin_id: c.id, is_active: 0 });
}

// ---------- Routing / Auth ----------

const route = (method: string, path: string, handler: (c: Ctx) => Promise<Response>) => ({
	method,
	pattern: new URLPattern({ pathname: `/api/v1/admin${path}` }),
	handler,
});

const ROUTES = [
	route("GET", "/houses", listHouses),
	route("POST", "/houses", createHouse),
	route("PATCH", "/houses/:id", updateHouse),
	route("GET", "/houses/:id", getHouse),
	route("POST", "/houses/:id/contacts", addContact),
	route("PATCH", "/contacts/:id", updateContact),
	route("DELETE", "/contacts/:id", removeContact),
	route("POST", "/contacts/:id/link-code", createLinkCode),
	route("POST", "/houses/:id/vehicles", addVehicle),
	route("PATCH", "/vehicles/:id", updateVehicle),
	route("DELETE", "/vehicles/:id", removeVehicle),
	route("PATCH", "/credentials/:id", updateCredential),
	route("POST", "/houses/:id/credentials", addCredential),
	route("DELETE", "/credentials/:id", revokeCredential),
	route("GET", "/projects", listProjects),
	route("POST", "/projects", createProject),
	route("GET", "/admins", listAdmins),
	route("POST", "/admins", createAdmin),
	route("DELETE", "/admins/:id", deactivateAdmin),
	route("POST", "/admins/:id/reset-password", resetAdminPassword),
	route("POST", "/me/password", changeMyPassword),
	route("GET", "/access-logs", listAccessLogs),
	route("GET", "/access-logs/:id/image", accessLogImage),
	route("GET", "/visitors", adminListVisitors),
	route("POST", "/visitors", adminCreateVisitor),
	route("PATCH", "/visitors/:id", adminUpdateVisitor),
	route("DELETE", "/visitors/:id", adminRevokeVisitor),
	route("PATCH", "/projects/:id", updateProject),
];

interface AdminRow {
	admin_id: string;
	project_id: string;
	admin_password: string;
	admin_level: string;
	must_change_password: number | null;
}

const getActiveAdmin = (env: Env, adminId: string) =>
	env.DB.prepare(
		"SELECT admin_id, project_id, admin_password, admin_level, must_change_password FROM tb_admin WHERE admin_id = ? AND is_active = 1 AND id_status = 'ACTIVE'",
	)
		.bind(adminId)
		.first<AdminRow>();

// รหัสโครงการ AAAA-AA11: ไม่สนตัวเล็กใหญ่ / ขีด / ช่องว่าง -> "PROJ-0001"; รูปแบบผิด = null
export function normalizeProjectCode(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const c = v.toUpperCase().replace(/[\s-]/g, "");
	return /^[A-Z]{4}[A-Z0-9]{4}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

// POST /api/v1/admin/login  { project_code, admin_name, password } -> JWT อายุ 1 ชั่วโมง
// ชื่อ admin ห้ามซ้ำเฉพาะในโครงการ; รหัสโครงการ / ชื่อ / รหัสผ่านผิด ตอบ INVALID_LOGIN เหมือนกัน (ไม่บอกว่าโครงการมีอยู่จริงไหม)
async function login(req: Request, env: Env): Promise<Response> {
	const body = await readJson(req);
	const projectCode = normalizeProjectCode(body?.project_code);
	if (!projectCode || !isStr(body?.admin_name, 128) || !isStr(body?.password, 256)) return json({ error: "BAD_REQUEST" }, 400);

	const admin = await env.DB.prepare(
		`SELECT a.admin_id, a.project_id, a.admin_password, a.admin_level, a.must_change_password, p.project_name FROM tb_admin a JOIN tb_project p ON p.project_id = a.project_id
		 WHERE p.project_code = ? AND p.is_active = 1 AND a.admin_name = ? AND a.is_active = 1 AND a.id_status = 'ACTIVE'`,
	)
		.bind(projectCode, body.admin_name)
		.first<AdminRow & { project_name: string }>();
	const ok = await verifyPassword(body.password, admin?.admin_password ?? DUMMY_HASH);
	if (!admin || !ok) return json({ error: "INVALID_LOGIN" }, 401);

	const now = Math.floor(Date.now() / 1000);
	const token = await signJwt(env.JWT_SECRET, {
		iss: JWT_ISS,
		aud: ADMIN_AUD,
		sub: admin.admin_id,
		pid: admin.project_id,
		scope: "admin",
		iat: now,
		exp: now + ADMIN_TTL_SEC,
	});
	await writeAudit(env, admin.project_id, "ADMIN", admin.admin_id, "LOGIN", admin.admin_id, {});
	return json({
		access_token: token,
		token_type: "Bearer",
		expires_in: ADMIN_TTL_SEC,
		project_code: projectCode,
		project_name: admin.project_name,
		admin_level: admin.admin_level,
		must_change_password: admin.must_change_password === 1,
	});
}

export async function handleAdmin(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	if (req.method === "POST" && url.pathname === "/api/v1/admin/login") return login(req, env);

	const match = ROUTES.map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url) : null })).find((x) => x.m);
	if (!match?.m) return json({ error: "NOT_FOUND" }, 404);

	// aud ต่างจาก device token จึงใช้ token ของอุปกรณ์เรียก admin API ไม่ได้
	const auth = req.headers.get("Authorization") ?? "";
	const claims = auth.startsWith("Bearer ") ? await verifyJwt(env.JWT_SECRET, auth.slice(7), JWT_ISS, ADMIN_AUD) : null;
	// เช็ค DB ทุกครั้ง เพื่อให้การปิดบัญชี admin มีผลทันที
	const admin = claims && (await getActiveAdmin(env, claims.sub));
	if (!claims || !admin || admin.project_id !== claims.pid) return json({ error: "UNAUTHORIZED" }, 401);
	// รหัสที่ Root ตั้งให้: ใช้ได้แค่เปลี่ยนรหัสผ่านจนกว่าจะตั้งรหัสของตัวเอง
	if (admin.must_change_password === 1 && url.pathname !== "/api/v1/admin/me/password") {
		return json({ error: "PASSWORD_CHANGE_REQUIRED" }, 403);
	}

	// ROOT จัดการโครงการอื่นได้ด้วย header X-Project-Code (ไม่ส่ง = โครงการของตัวเอง); ADMIN ใช้ของตัวเองเสมอ
	let pid = admin.project_id;
	const asProject = req.headers.get("X-Project-Code");
	if (admin.admin_level === "ROOT" && asProject) {
		const code = normalizeProjectCode(asProject);
		const target = code && (await env.DB.prepare("SELECT project_id FROM tb_project WHERE project_code = ?").bind(code).first<{ project_id: string }>());
		if (!target) return json({ error: "PROJECT_NOT_FOUND" }, 404);
		pid = target.project_id;
	}

	const needsBody = req.method === "POST" || req.method === "PATCH";
	const body = needsBody ? await readJson(req) : {};
	if (!body) return json({ error: "BAD_REQUEST" }, 400);

	try {
		const id = decodeURIComponent(match.m.pathname.groups.id ?? "");
		const res = await match.r.handler({ env, adminId: admin.admin_id, level: admin.admin_level, pid, id, body, url });
		if (req.method !== "GET" && res.ok) {
			const action = `${req.method} ${match.r.pattern.pathname}`;
			await writeAudit(env, pid, "ADMIN", admin.admin_id, action, await auditTarget(res, id), body);
		}
		return res;
	} catch (err) {
		return errorResponse(err);
	}
}
