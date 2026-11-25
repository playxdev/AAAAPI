import { auditTarget, writeAudit } from "./audit";
import { credentialHash, normalizePlate, normalizeProvince, type Method } from "./authorize";
import { JWT_ISS, sha256Hex, signJwt, verifyJwt, verifyPassword } from "./crypto";
import { COMMON_AREA_PREFIX, DURATION_DAYS, HOUSE_CODE_RE, issueGuest, listVisitors, revokeVisitor } from "./guest";
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
	pid: string; // project_id ของ admin ที่ login ทุก query ต้องกรองด้วยค่านี้
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

function optDate(body: Body, name: string): string | null | undefined {
	const v = optStr(body, name, 40);
	if (v && Number.isNaN(Date.parse(v))) throw badField(name);
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
const CONTACT_ROLES = ["OWNER", "RESIDENT", "TENANT"];
const CONTACT_COLS = "user_id, house_id, full_name, phone_number, role, line_user_id IS NOT NULL AS line_linked";
// เจ้าบ้านขึ้นก่อน (= ผู้ติดต่อหลัก) แล้วตามลำดับที่เพิ่ม
const CONTACT_ORDER = "CASE role WHEN 'OWNER' THEN 0 WHEN 'TENANT' THEN 1 ELSE 2 END, autoID";

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
			"SELECT vehicle_id, license_plate, province, brand, color, is_active FROM tb_vehicle WHERE house_id = ? AND project_id = ?",
		).bind(c.id, c.pid),
		// ห้ามคืน cred_hash
		db.prepare(
			`SELECT credential_id, cred_type, valid_from, valid_until, max_uses, use_count, is_active, id_status
			 FROM tb_credential WHERE house_id = ? AND project_id = ?`,
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

// บ้านต้องมีอยู่ และไม่ใช่ "ไม่มีผู้อยู่อาศัย" ถึงจะเพิ่มช่องทางเข้าออก / ผู้เยี่ยมชมได้
async function requireOccupiedHouse(c: Ctx, houseId: string) {
	const house = await c.env.DB.prepare("SELECT occupancy_status, house_code FROM tb_house WHERE house_id = ? AND project_id = ?")
		.bind(houseId, c.pid)
		.first<{ occupancy_status: string | null; house_code: string | null }>();
	if (!house) throw notFound();
	if (house.occupancy_status === "VACANT") throw new HttpError(409, "HOUSE_VACANT", "house_id");
	return house;
}

// ---------- Contacts (tb_user) ----------

async function addContact(c: Ctx) {
	await requireRow(c, "tb_house", "house_id", c.id);
	const userId = crypto.randomUUID();
	await c.env.DB.prepare("INSERT INTO tb_user (user_id, project_id, house_id, full_name, phone_number, role) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(
			userId,
			c.pid,
			c.id,
			reqStr(c.body, "full_name", 128),
			optStr(c.body, "phone_number", 32) ?? null,
			optEnum(c.body, "role", CONTACT_ROLES) ?? "RESIDENT",
		)
		.run();
	return json({ user_id: userId }, 201);
}

async function updateContact(c: Ctx) {
	await patchRow(c, "tb_user", "user_id", {
		full_name: c.body.full_name === undefined ? undefined : reqStr(c.body, "full_name", 128),
		phone_number: optStr(c.body, "phone_number", 32),
		role: optEnum(c.body, "role", CONTACT_ROLES),
	});
	return json({ user_id: c.id });
}

// Soft delete: audit / visitor ที่เขาออกยังอ้างอิงได้; บัญชี LINE ของเขาใช้ไม่ได้ทันที
async function removeContact(c: Ctx) {
	await patchRow(c, "tb_user", "user_id", { is_active: 0 });
	return json({ user_id: c.id, is_active: 0 });
}

// ---------- Vehicles ----------

async function addVehicle(c: Ctx) {
	await requireOccupiedHouse(c, c.id);
	const plate = normalizePlate(reqStr(c.body, "license_plate", 32));
	// หมวด (1กข / กข / รวย / 70) + เลข 1-4 หลัก; จังหวัดอยู่อีกช่อง
	if (!PLATE_RE.test(plate)) throw badField("license_plate");
	const province = normalizeProvince(optStr(c.body, "province", 64));
	// ป้ายเดียวกันต่างจังหวัด = คนละคัน; ไม่ระบุจังหวัด = ชนกับทุกจังหวัด
	const dup = await c.env.DB.prepare(
		"SELECT 1 FROM tb_vehicle WHERE project_id = ? AND license_plate = ? AND is_active = 1 AND (? IS NULL OR province IS NULL OR province = ?)",
	)
		.bind(c.pid, plate, province, province)
		.first();
	if (dup) throw new HttpError(409, "PLATE_EXISTS", "license_plate");

	const vehicleId = crypto.randomUUID();
	await c.env.DB.prepare(
		"INSERT INTO tb_vehicle (vehicle_id, project_id, house_id, license_plate, province, brand, color) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			vehicleId,
			c.pid,
			c.id,
			plate,
			province,
			optStr(c.body, "brand", 64) ?? null,
			optStr(c.body, "color", 32) ?? null,
		)
		.run();
	return json({ vehicle_id: vehicleId, license_plate: plate }, 201);
}

async function removeVehicle(c: Ctx) {
	await patchRow(c, "tb_vehicle", "vehicle_id", { is_active: 0 });
	return json({ vehicle_id: c.id, is_active: 0 });
}

// ---------- Credentials ----------

async function addCredential(c: Ctx) {
	await requireOccupiedHouse(c, c.id);
	const credType = optEnum(c.body, "cred_type", ADMIN_CRED_TYPES) as Method | undefined;
	if (!credType) throw badField("cred_type");
	// QRCODE: 20 chars of LINK_CODE_ALPHABET (100 bits). Admin UI generates it so the admin sees it before saving;
	// no value = server generates. Returned once in the response; DB keeps only the hash.
	const value = credType === "QRCODE" ? (optStr(c.body, "value", 20) ?? randomCode(20)) : reqStr(c.body, "value", 256);
	if (credType === "QRCODE" && !QR_RE.test(value)) throw badField("value");
	if (credType === "PIN" && !/^\d{4,8}$/.test(value)) throw badField("value");
	// PIN ห้ามชนกับ Guest Code เพราะ Keypad ส่งมาเป็น method PIN เหมือนกัน
	if (credType === "PIN") {
		const guestClash = await c.env.DB.prepare("SELECT 1 FROM tb_credential WHERE project_id = ? AND cred_type = 'GUEST' AND cred_hash = ?")
			.bind(c.pid, await credentialHash(c.env.CRED_PEPPER, c.pid, "GUEST", value))
			.first();
		if (guestClash) throw new HttpError(409, "CREDENTIAL_EXISTS", "value");
	}

	// วันหมดอายุ: valid_until (กำหนดเอง) > duration (forever = ไม่มีกำหนด / NULL) > ไม่ระบุ = 24 ชั่วโมง
	const duration = optEnum(c.body, "duration", Object.keys(DURATION_DAYS));
	const days = DURATION_DAYS[duration ?? "1d"];
	const validUntil =
		optDate(c.body, "valid_until") ??
		(duration === "forever" ? null : new Date(Date.now() + days * 86_400_000).toISOString().replace("T", " ").slice(0, 19));

	const credentialId = crypto.randomUUID();
	try {
		await c.env.DB.prepare(
			`INSERT INTO tb_credential (credential_id, project_id, house_id, cred_type, cred_hash, valid_from, valid_until)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				credentialId,
				c.pid,
				c.id,
				credType,
				await credentialHash(c.env.CRED_PEPPER, c.pid, credType, value),
				optDate(c.body, "valid_from") ?? null,
				validUntil,
			)
			.run();
	} catch (err) {
		if (isUniqueViolation(err)) throw new HttpError(409, "CREDENTIAL_EXISTS", "value");
		throw err;
	}
	return json({ credential_id: credentialId, cred_type: credType, ...(credType === "QRCODE" && { value }) }, 201);
}

async function revokeCredential(c: Ctx) {
	await patchRow(c, "tb_credential", "credential_id", { is_active: 0, id_status: "REVOKED" });
	return json({ credential_id: c.id, id_status: "REVOKED" });
}

// ---------- LINE link code ----------

// truck/bus: 2-digit category + exactly 4 digits, otherwise a pure number like "1234" would pass
const PLATE_RE = /^(\d?[ก-ฮ]{1,3}\d{1,4}|\d{6})$/;
const QR_RE = /^[A-HJ-NP-Z2-9]{20}$/;
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// 32 symbols, so b % 32 has no modulo bias.
const randomCode = (len: number) =>
	[...crypto.getRandomValues(new Uint8Array(len))].map((b) => LINK_CODE_ALPHABET[b % 32]).join("");
const LINK_CODE_TTL = "+1 day";

// รหัสครั้งเดียวให้ผู้ติดต่อของบ้านกรอกใน LIFF เพื่อผูกบัญชี LINE กับ tb_user
async function createLinkCode(c: Ctx) {
	const code = randomCode(8);
	const res = await c.env.DB.prepare(
		`UPDATE tb_user SET link_code_hash = ?, link_code_expires = datetime('now', ?)
		 WHERE user_id = ? AND project_id = ? AND is_active = 1`,
	)
		.bind(await sha256Hex(code), LINK_CODE_TTL, c.id, c.pid)
		.run();
	if (res.meta.changes === 0) throw notFound();
	return json({ user_id: c.id, link_code: code, expires_in: 86_400 }, 201);
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
	let prefix = COMMON_AREA_PREFIX;
	if (houseId) {
		const house = await requireOccupiedHouse(c, houseId);
		if (!house.house_code) throw new HttpError(409, "HOUSE_CODE_MISSING", "house_id");
		prefix = house.house_code;
	}
	const issueCode = optBool(c.body, "issue_code") ?? true;
	return json(await issueGuest(c.env, c.pid, { houseId, prefix, issuedBy: "ADMIN", issuedById: c.adminId, issueCode }, c.body), 201);
}

async function adminRevokeVisitor(c: Ctx) {
	await revokeVisitor(c.env, c.pid, c.id);
	return json({ visitor_id: c.id, id_status: "REVOKED" });
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
	route("DELETE", "/vehicles/:id", removeVehicle),
	route("POST", "/houses/:id/credentials", addCredential),
	route("DELETE", "/credentials/:id", revokeCredential),
	route("GET", "/visitors", adminListVisitors),
	route("POST", "/visitors", adminCreateVisitor),
	route("DELETE", "/visitors/:id", adminRevokeVisitor),
];

interface AdminRow {
	admin_id: string;
	project_id: string;
	admin_password: string;
}

const getActiveAdmin = (env: Env, adminId: string) =>
	env.DB.prepare(
		"SELECT admin_id, project_id, admin_password FROM tb_admin WHERE admin_id = ? AND is_active = 1 AND id_status = 'ACTIVE'",
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
		`SELECT a.admin_id, a.project_id, a.admin_password FROM tb_admin a JOIN tb_project p ON p.project_id = a.project_id
		 WHERE p.project_code = ? AND p.is_active = 1 AND a.admin_name = ? AND a.is_active = 1 AND a.id_status = 'ACTIVE'`,
	)
		.bind(projectCode, body.admin_name)
		.first<AdminRow>();
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
	return json({ access_token: token, token_type: "Bearer", expires_in: ADMIN_TTL_SEC, project_code: projectCode });
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

	const needsBody = req.method === "POST" || req.method === "PATCH";
	const body = needsBody ? await readJson(req) : {};
	if (!body) return json({ error: "BAD_REQUEST" }, 400);

	try {
		const id = decodeURIComponent(match.m.pathname.groups.id ?? "");
		const res = await match.r.handler({ env, adminId: admin.admin_id, pid: admin.project_id, id, body, url });
		if (req.method !== "GET" && res.ok) {
			const action = `${req.method} ${match.r.pattern.pathname}`;
			await writeAudit(env, admin.project_id, "ADMIN", admin.admin_id, action, await auditTarget(res, id), body);
		}
		return res;
	} catch (err) {
		return errorResponse(err);
	}
}
