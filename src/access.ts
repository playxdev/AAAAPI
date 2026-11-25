// สิทธิ์เข้าออกของบ้าน + คนในบ้าน ใช้ร่วมกันระหว่าง Admin API และ Owner API (LINE Mini App)
import type { ActorType } from "./audit";
import { credentialHash, type Method } from "./authorize";
import { DURATION_DAYS } from "./guest";
import { type Body, badField, HttpError, isUniqueViolation, notFound, optEnum, optStr, reqStr } from "./http";

export const PIN_LIMIT = 20; // PIN ที่ใช้งานอยู่ต่อบ้าน
export const QR_LIMIT = 20; // QR ที่ใช้งานอยู่ต่อบ้าน
export const LABEL_MAX = 32;

// 32 ตัว (ไม่มี I O 0 1) จึงใช้ b % 32 ได้โดยไม่ bias
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const randomCode = (len: number) =>
	[...crypto.getRandomValues(new Uint8Array(len))].map((b) => CODE_ALPHABET[b % 32]).join("");
const random4 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
const QR_SUFFIX_RE = /^[A-HJ-NP-Z2-9]{20}$/;
const MAX_TRIES = 10;

export interface Issuer {
	type: ActorType;
	id: string;
}

const sqlTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

interface HouseRow {
	house_id: string;
	house_code: string | null;
	occupancy_status: string | null;
	project_code: string | null;
	house_auto: number;
}

async function getHouse(env: Env, pid: string, houseId: string) {
	const h = await env.DB.prepare(
		`SELECT h.house_id, h.house_code, h.occupancy_status, p.project_code, h.autoID AS house_auto
		 FROM tb_house h JOIN tb_project p ON p.project_id = h.project_id WHERE h.house_id = ? AND h.project_id = ?`,
	)
		.bind(houseId, pid)
		.first<HouseRow>();
	if (!h) throw notFound();
	return h;
}

// บ้านต้องมีอยู่ และไม่ใช่ "ไม่มีผู้อยู่อาศัย" ถึงจะเพิ่มช่องทางเข้าออก / ผู้เยี่ยมชมได้
export async function requireOccupiedHouse(env: Env, pid: string, houseId: string) {
	const h = await getHouse(env, pid, houseId);
	if (h.occupancy_status === "VACANT") throw new HttpError(409, "HOUSE_VACANT", "house_id");
	return h;
}

// ---------- Credentials (RFID / PIN / QR) ----------

/**
 * PIN = house_code + 4 หลัก (เช่น 98061234 กดที่ Keypad), QR = house_code + 20 ตัว (เช่น 9806P5MJ3G...)
 * ไม่ส่ง value = สุ่มให้ (PIN / QR); คืน value เต็มครั้งเดียวใน response (DB เก็บแค่ hash)
 * PIN / QR ที่ใช้งานอยู่ไม่เกิน 20 ชุดต่อบ้าน; RFID เฉพาะ Admin / Root
 */
export async function addCredential(env: Env, pid: string, houseId: string, issuer: Issuer, body: Body, types: readonly Method[]) {
	const house = await requireOccupiedHouse(env, pid, houseId);
	const credType = optEnum(body, "cred_type", types) as Method | undefined;
	if (!credType) throw badField("cred_type");
	const label = optStr(body, "label", LABEL_MAX) ?? null;

	// null = ไม่มีกำหนด (forever) ต่างจาก undefined = ไม่ส่ง -> 24 ชั่วโมง (จึงใช้ ?? ไม่ได้)
	const given = parseValidUntil(body);
	const validUntil = given === undefined ? sqlTime(new Date(Date.now() + 86_400_000)) : given;
	const validFrom = optStr(body, "valid_from", 40) ?? null;
	if (validFrom && Number.isNaN(Date.parse(validFrom))) throw badField("valid_from");

	// ค่าที่จะลงทะเบียน: fixed = ผู้ใช้กำหนดเอง (ซ้ำ = 409), ไม่ fixed = สุ่มใหม่เมื่อชน
	let next: () => string;
	let fixed = true;
	if (credType === "RFID") {
		const v = reqStr(body, "value", 256);
		next = () => v;
	} else {
		if (!house.house_code) throw new HttpError(409, "HOUSE_CODE_MISSING", "house_id");
		const limit = credType === "PIN" ? PIN_LIMIT : QR_LIMIT;
		const active = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM tb_credential WHERE house_id = ? AND cred_type = ? AND is_active = 1
			   AND (valid_until IS NULL OR datetime(valid_until) >= datetime('now'))`,
		)
			.bind(houseId, credType)
			.first<number>("n");
		if ((active ?? 0) >= limit) throw new HttpError(409, "LIMIT_REACHED", "cred_type");

		const given = optStr(body, "value", 20);
		const re = credType === "PIN" ? /^\d{4}$/ : QR_SUFFIX_RE;
		if (given && !re.test(given)) throw badField("value");
		fixed = !!given;
		const rand = credType === "PIN" ? random4 : () => randomCode(20);
		next = () => house.house_code + (given || rand());
	}

	for (let i = 0; i < (fixed ? 1 : MAX_TRIES); i++) {
		const value = next();
		// PIN ห้ามชนกับ Guest Code (Keypad ส่งมาเป็น method PIN เหมือนกัน)
		if (credType === "PIN") {
			const guest = await env.DB.prepare("SELECT 1 FROM tb_credential WHERE project_id = ? AND cred_type = 'GUEST' AND cred_hash = ?")
				.bind(pid, await credentialHash(env.CRED_PEPPER, pid, "GUEST", value))
				.first();
			if (guest) {
				if (fixed) throw new HttpError(409, "CREDENTIAL_EXISTS", "value");
				continue;
			}
		}
		const credentialId = crypto.randomUUID();
		try {
			await env.DB.prepare(
				`INSERT INTO tb_credential (credential_id, project_id, house_id, cred_type, cred_hash, valid_from, valid_until,
				   label, issued_by_type, issued_by_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					credentialId,
					pid,
					houseId,
					credType,
					await credentialHash(env.CRED_PEPPER, pid, credType, value),
					validFrom,
					validUntil,
					label,
					issuer.type,
					issuer.id,
				)
				.run();
			// RFID ไม่คืนค่า (ผู้ใช้รู้อยู่แล้ว); PIN / QR คืนครั้งเดียว
			return { credential_id: credentialId, cred_type: credType, label, valid_until: validUntil, ...(credType !== "RFID" && { value }) };
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
			if (fixed) throw new HttpError(409, "CREDENTIAL_EXISTS", "value");
		}
	}
	throw new HttpError(409, "CREDENTIAL_UNAVAILABLE", "value");
}

/**
 * วันหมดอายุจาก body: valid_until (กำหนดเอง) > duration (forever = ไม่มีกำหนด / NULL, นับจากตอนนี้)
 * ไม่ส่งทั้งคู่ = undefined (เพิ่มใหม่ = 24 ชั่วโมง, แก้ = ไม่เปลี่ยน)
 */
function parseValidUntil(body: Body): string | null | undefined {
	const custom = optStr(body, "valid_until", 40);
	if (custom) {
		if (Number.isNaN(Date.parse(custom))) throw badField("valid_until");
		return custom;
	}
	const duration = optEnum(body, "duration", Object.keys(DURATION_DAYS));
	if (!duration) return undefined;
	return duration === "forever" ? null : sqlTime(new Date(Date.now() + DURATION_DAYS[duration] * 86_400_000));
}

/** แก้ชื่อสั้น / ระยะเวลาของ PIN / QR / RFID; onlyIssuer = คนในบ้านแก้ได้แค่ที่ตัวเองสร้าง */
export async function updateCredential(env: Env, pid: string, credentialId: string, body: Body, onlyIssuer?: Issuer & { houseId: string }) {
	const sets: Record<string, unknown> = { label: optStr(body, "label", LABEL_MAX), valid_until: parseValidUntil(body) };
	const cols = Object.keys(sets).filter((k) => sets[k] !== undefined);
	if (cols.length === 0) throw badField("body");
	const own = onlyIssuer ? " AND house_id = ? AND issued_by_type = ? AND issued_by_id = ?" : "";
	const args = onlyIssuer ? [onlyIssuer.houseId, onlyIssuer.type, onlyIssuer.id] : [];
	const res = await env.DB.prepare(
		`UPDATE tb_credential SET ${cols.map((k) => `${k} = ?`).join(", ")}
		 WHERE credential_id = ? AND project_id = ? AND visitor_id IS NULL AND is_active = 1${own}`,
	)
		.bind(...cols.map((k) => sets[k]), credentialId, pid, ...args)
		.run();
	if (res.meta.changes === 0) throw notFound();
}

/** ชื่อสั้นเป็นหน้าที่ของคนในบ้าน: เจ้าบ้านตั้งชื่อรถ / บัตร / รหัสได้ทุกรายการในบ้าน (รวมที่ Admin เพิ่มให้) */
export async function relabel(env: Env, houseId: string, table: "tb_vehicle" | "tb_credential", idCol: string, id: string, body: Body) {
	const label = optStr(body, "label", LABEL_MAX);
	if (label === undefined) throw badField("label");
	const res = await env.DB.prepare(`UPDATE ${table} SET label = ? WHERE ${idCol} = ? AND house_id = ? AND is_active = 1`)
		.bind(label, id, houseId)
		.run();
	if (res.meta.changes === 0) throw notFound();
}

/** onlyIssuer: คนในบ้านลบได้แค่ที่ตัวเองสร้าง; ไม่ส่ง = Admin / Root ลบได้ทั้งโครงการ */
export async function revokeCredential(env: Env, pid: string, credentialId: string, onlyIssuer?: Issuer & { houseId: string }) {
	const own = onlyIssuer ? " AND house_id = ? AND issued_by_type = ? AND issued_by_id = ?" : "";
	const args = onlyIssuer ? [onlyIssuer.houseId, onlyIssuer.type, onlyIssuer.id] : [];
	const res = await env.DB.prepare(
		`UPDATE tb_credential SET is_active = 0, id_status = 'REVOKED' WHERE credential_id = ? AND project_id = ? AND visitor_id IS NULL${own}`,
	)
		.bind(credentialId, pid, ...args)
		.run();
	if (res.meta.changes === 0) throw notFound();
}

export const credentialColumns =
	"credential_id, cred_type, label, valid_from, valid_until, max_uses, use_count, is_active, id_status, issued_by_type, issued_by_id";

// ---------- คนในบ้าน (tb_user) ----------

export const HOUSE_ROLES = ["OWNER", "FAMILY", "RESIDENT", "TENANT"] as const;
export const MEMBER_ROLES = ["FAMILY", "RESIDENT", "TENANT"] as const;

// เจ้าบ้านมีได้ 1 คน: ตั้งคนใหม่เป็นเจ้าบ้าน = เจ้าบ้านเดิมกลายเป็นผู้พักอาศัย (ไม่ต้องผูก LINE ใหม่)
export const demoteOwner = (env: Env, houseId: string, exceptUserId = "") =>
	env.DB.prepare("UPDATE tb_user SET role = 'RESIDENT' WHERE house_id = ? AND role = 'OWNER' AND is_active = 1 AND user_id <> ?").bind(
		houseId,
		exceptUserId,
	);

/** สร้างคนในบ้าน + ref ที่ไม่ซ้ำทั้งระบบ เช่น PROJ-0001-9806-01 */
export async function createHouseUser(env: Env, pid: string, houseId: string, body: Body, roles: readonly string[], defaultRole: string) {
	const house = await getHouse(env, pid, houseId);
	const role = optEnum(body, "role", roles) ?? defaultRole;
	const fullName = reqStr(body, "full_name", 128);
	const phone = optStr(body, "phone_number", 32) ?? null;
	const prefix = `${house.project_code}-${house.house_code ?? `H${house.house_auto}`}-`;
	const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tb_user WHERE house_id = ?").bind(houseId).first<number>("n")) ?? 0;

	for (let n = count + 1; n < count + 1 + MAX_TRIES; n++) {
		const userId = crypto.randomUUID();
		const ref = prefix + String(n).padStart(2, "0");
		const insert = env.DB.prepare(
			"INSERT INTO tb_user (user_id, project_id, house_id, full_name, phone_number, role, ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(userId, pid, houseId, fullName, phone, role, ref);
		try {
			await env.DB.batch(role === "OWNER" ? [demoteOwner(env, houseId), insert] : [insert]);
			return { user_id: userId, ref, role };
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
		}
	}
	throw new HttpError(409, "CONFLICT", "ref");
}

const LINK_CODE_TTL = "+1 day";

/** รหัสเชื่อม LINE 8 ตัว ใช้ครั้งเดียว อายุ 24 ชม.; extraWhere จำกัดว่าออกให้ใครได้ */
export async function issueLinkCode(env: Env, sha256Hex: (v: string) => Promise<string>, userId: string, pid: string, extraWhere = "", extraArgs: unknown[] = []) {
	const code = randomCode(8);
	const res = await env.DB.prepare(
		`UPDATE tb_user SET link_code_hash = ?, link_code_expires = datetime('now', ?)
		 WHERE user_id = ? AND project_id = ? AND is_active = 1${extraWhere}`,
	)
		.bind(await sha256Hex(code), LINK_CODE_TTL, userId, pid, ...extraArgs)
		.run();
	if (res.meta.changes === 0) throw notFound();
	return { user_id: userId, link_code: code, expires_in: 86_400 };
}
