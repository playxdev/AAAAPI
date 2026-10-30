import { auditTarget, writeAudit } from "./audit";
import { credentialHash, normalizePlate, type Method } from "./authorize";
import { JWT_ISS, sha256Hex, signJwt, verifyJwt, verifyPassword } from "./crypto";
import { COMMON_AREA_PREFIX, HOUSE_CODE_RE, issueGuest, listVisitors, revokeVisitor } from "./guest";
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

const HOUSE_COLS = "house_id, house_number, house_code, zone_or_soi, payment_status, is_active, update_date";

async function listHouses(c: Ctx) {
	const { results } = await c.env.DB.prepare(`SELECT ${HOUSE_COLS} FROM tb_house WHERE project_id = ? ORDER BY house_number`)
		.bind(c.pid)
		.all();
	return json({ houses: results });
}

async function createHouse(c: Ctx) {
	const houseId = crypto.randomUUID();
	await c.env.DB.prepare("INSERT INTO tb_house (house_id, project_id, house_number, house_code, zone_or_soi) VALUES (?, ?, ?, ?, ?)")
		.bind(houseId, c.pid, reqStr(c.body, "house_number", 32), optHouseCode(c.body) ?? null, optStr(c.body, "zone_or_soi", 64) ?? null)
		.run();
	return json({ house_id: houseId }, 201);
}

async function updateHouse(c: Ctx) {
	await patchRow(c, "tb_house", "house_id", {
		house_number: c.body.house_number === undefined ? undefined : reqStr(c.body, "house_number", 32),
		house_code: optHouseCode(c.body),
		zone_or_soi: optStr(c.body, "zone_or_soi", 64),
		payment_status: optEnum(c.body, "payment_status", PAYMENT_STATUSES),
		is_active: optActive(c.body),
	});
	return json({ house_id: c.id });
}

// ---------- Residents ----------

const RESIDENT_COLS = "user_id, house_id, full_name, phone_number, line_id, role, is_active, update_date";

async function listResidents(c: Ctx) {
	const houseId = c.url.searchParams.get("house_id");
	const stmt = houseId
		? c.env.DB.prepare(`SELECT ${RESIDENT_COLS} FROM tb_user WHERE project_id = ? AND house_id = ? ORDER BY full_name`).bind(c.pid, houseId)
		: c.env.DB.prepare(`SELECT ${RESIDENT_COLS} FROM tb_user WHERE project_id = ? ORDER BY full_name`).bind(c.pid);
	return json({ residents: (await stmt.all()).results });
}

async function getResident(c: Ctx) {
	const db = c.env.DB;
	const [resident, vehicles, credentials] = await db.batch([
		db.prepare(`SELECT ${RESIDENT_COLS} FROM tb_user WHERE user_id = ? AND project_id = ?`).bind(c.id, c.pid),
		db.prepare(
			"SELECT vehicle_id, license_plate, province, brand, color, is_active FROM tb_vehicle WHERE user_id = ? AND project_id = ?",
		).bind(c.id, c.pid),
		// ห้ามคืน cred_hash
		db.prepare(
			`SELECT credential_id, cred_type, valid_from, valid_until, max_uses, use_count, is_active, id_status
			 FROM tb_credential WHERE user_id = ? AND project_id = ?`,
		).bind(c.id, c.pid),
	]);
	if (resident.results.length === 0) throw notFound();
	return json({ ...(resident.results[0] as Record<string, unknown>), vehicles: vehicles.results, credentials: credentials.results });
}

async function createResident(c: Ctx) {
	const houseId = reqStr(c.body, "house_id", 64);
	await requireRow(c, "tb_house", "house_id", houseId);
	const userId = crypto.randomUUID();
	await c.env.DB.prepare(
		"INSERT INTO tb_user (user_id, project_id, house_id, full_name, phone_number, line_id) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(
			userId,
			c.pid,
			houseId,
			reqStr(c.body, "full_name", 128),
			optStr(c.body, "phone_number", 32) ?? null,
			optStr(c.body, "line_id", 64) ?? null,
		)
		.run();
	return json({ user_id: userId }, 201);
}

async function updateResident(c: Ctx) {
	const houseId = c.body.house_id === undefined ? undefined : reqStr(c.body, "house_id", 64);
	if (houseId) await requireRow(c, "tb_house", "house_id", houseId);
	await patchRow(c, "tb_user", "user_id", {
		house_id: houseId,
		full_name: c.body.full_name === undefined ? undefined : reqStr(c.body, "full_name", 128),
		phone_number: optStr(c.body, "phone_number", 32),
		line_id: optStr(c.body, "line_id", 64),
		is_active: optActive(c.body),
	});
	return json({ user_id: c.id });
}

// Soft delete: เก็บข้อมูลไว้ให้ access log อ้างอิงได้ ลูกบ้านที่ inactive จะเข้าไม่ได้ทุกวิธี
async function deactivateResident(c: Ctx) {
	await patchRow(c, "tb_user", "user_id", { is_active: 0 });
	return json({ user_id: c.id, is_active: 0 });
}

// ---------- Vehicles ----------

async function addVehicle(c: Ctx) {
	await requireRow(c, "tb_user", "user_id", c.id);
	const plate = normalizePlate(reqStr(c.body, "license_plate", 32));
	if (!plate) throw badField("license_plate");
	const dup = await c.env.DB.prepare(
		"SELECT 1 FROM tb_vehicle WHERE project_id = ? AND license_plate = ? AND is_active = 1",
	)
		.bind(c.pid, plate)
		.first();
	if (dup) throw new HttpError(409, "PLATE_EXISTS", "license_plate");

	const vehicleId = crypto.randomUUID();
	await c.env.DB.prepare(
		"INSERT INTO tb_vehicle (vehicle_id, project_id, user_id, license_plate, province, brand, color) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			vehicleId,
			c.pid,
			c.id,
			plate,
			optStr(c.body, "province", 64) ?? null,
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
	await requireRow(c, "tb_user", "user_id", c.id);
	const credType = optEnum(c.body, "cred_type", ADMIN_CRED_TYPES) as Method | undefined;
	if (!credType) throw badField("cred_type");
	const value = reqStr(c.body, "value", 256);
	if (credType === "PIN" && !/^\d{4,8}$/.test(value)) throw badField("value");
	// PIN ห้ามชนกับ Guest Code เพราะ Keypad ส่งมาเป็น method PIN เหมือนกัน
	if (credType === "PIN") {
		const guestClash = await c.env.DB.prepare("SELECT 1 FROM tb_credential WHERE project_id = ? AND cred_type = 'GUEST' AND cred_hash = ?")
			.bind(c.pid, await credentialHash(c.env.CRED_PEPPER, c.pid, "GUEST", value))
			.first();
		if (guestClash) throw new HttpError(409, "CREDENTIAL_EXISTS", "value");
	}

	const credentialId = crypto.randomUUID();
	try {
		await c.env.DB.prepare(
			`INSERT INTO tb_credential (credential_id, project_id, user_id, cred_type, cred_hash, valid_from, valid_until)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				credentialId,
				c.pid,
				c.id,
				credType,
				await credentialHash(c.env.CRED_PEPPER, c.pid, credType, value),
				optDate(c.body, "valid_from") ?? null,
				optDate(c.body, "valid_until") ?? null,
			)
			.run();
	} catch (err) {
		if (isUniqueViolation(err)) throw new HttpError(409, "CREDENTIAL_EXISTS", "value");
		throw err;
	}
	return json({ credential_id: credentialId, cred_type: credType }, 201);
}

async function revokeCredential(c: Ctx) {
	await patchRow(c, "tb_credential", "credential_id", { is_active: 0, id_status: "REVOKED" });
	return json({ credential_id: c.id, id_status: "REVOKED" });
}

// ---------- LINE link code ----------

const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_CODE_TTL = "+1 day";

// รหัสครั้งเดียวให้ลูกบ้านกรอกใน LIFF เพื่อผูกบัญชี LINE กับ tb_user
async function createLinkCode(c: Ctx) {
	const code = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => LINK_CODE_ALPHABET[b % 32]).join("");
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
		const house = await c.env.DB.prepare("SELECT house_code FROM tb_house WHERE house_id = ? AND project_id = ?")
			.bind(houseId, c.pid)
			.first<{ house_code: string | null }>();
		if (!house) throw notFound();
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
	route("GET", "/residents", listResidents),
	route("POST", "/residents", createResident),
	route("GET", "/residents/:id", getResident),
	route("PATCH", "/residents/:id", updateResident),
	route("DELETE", "/residents/:id", deactivateResident),
	route("POST", "/residents/:id/vehicles", addVehicle),
	route("DELETE", "/vehicles/:id", removeVehicle),
	route("POST", "/residents/:id/credentials", addCredential),
	route("DELETE", "/credentials/:id", revokeCredential),
	route("POST", "/residents/:id/link-code", createLinkCode),
	route("GET", "/visitors", adminListVisitors),
	route("POST", "/visitors", adminCreateVisitor),
	route("DELETE", "/visitors/:id", adminRevokeVisitor),
];

interface AdminRow {
	admin_id: string;
	project_id: string;
	admin_password: string;
}

const getActiveAdmin = (env: Env, col: "admin_id" | "admin_name", value: string) =>
	env.DB.prepare(
		`SELECT admin_id, project_id, admin_password FROM tb_admin WHERE ${col} = ? AND is_active = 1 AND id_status = 'ACTIVE'`,
	)
		.bind(value)
		.first<AdminRow>();

// POST /api/v1/admin/login  { admin_name, password } -> JWT อายุ 1 ชั่วโมง
async function login(req: Request, env: Env): Promise<Response> {
	const body = await readJson(req);
	if (!isStr(body?.admin_name, 128) || !isStr(body?.password, 256)) return json({ error: "BAD_REQUEST" }, 400);

	const admin = await getActiveAdmin(env, "admin_name", body.admin_name);
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
	return json({ access_token: token, token_type: "Bearer", expires_in: ADMIN_TTL_SEC });
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
	const admin = claims && (await getActiveAdmin(env, "admin_id", claims.sub));
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
