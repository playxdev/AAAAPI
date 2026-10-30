import { credentialHash, normalizePlate } from "./authorize";
import { type Body, HttpError, isUniqueViolation, optStr, reqEnum } from "./http";
import type { ActorType } from "./audit";

// ระยะเวลาที่เลือกได้ (วัน); forever = 100 ปี
export const DURATION_DAYS: Record<string, number> = { "1d": 1, "7d": 7, "14d": 14, "30d": 30, "1y": 365, forever: 36500 };

// Guest Code ของงานส่วนกลาง (ไม่มีบ้าน) ใช้ prefix 0 ซึ่ง house_code ใช้ไม่ได้
export const COMMON_AREA_PREFIX = "0";
export const HOUSE_CODE_RE = /^[1-9]\d{0,5}$/;

const MAX_CODE_ATTEMPTS = 10;

export interface GuestRequest {
	houseId: string | null;
	prefix: string;
	issuedBy: ActorType;
	issuedById: string;
	issueCode: boolean;
}

const random4 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");

// เวลาแบบเดียวกับ CURRENT_TIMESTAMP ของ SQLite (UTC)
const sqlTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

// สร้าง Visitor (+ Guest Code ถ้า issueCode) จาก body: duration, full_name?, phone_number?, license_plate?, purpose?
export async function issueGuest(env: Env, projectId: string, g: GuestRequest, body: Body) {
	const days = DURATION_DAYS[reqEnum(body, "duration", Object.keys(DURATION_DAYS))];
	const plate = optStr(body, "license_plate", 32);
	const now = new Date();
	const validFrom = sqlTime(now);
	const validUntil = sqlTime(new Date(now.getTime() + days * 86_400_000));
	const visitorId = crypto.randomUUID();

	const insertVisitor = env.DB.prepare(
		`INSERT INTO tb_visitor (visitor_id, project_id, house_id, full_name, phone_number, license_plate, purpose,
		   valid_from, valid_until, issued_by_type, issued_by_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		visitorId,
		projectId,
		g.houseId,
		optStr(body, "full_name", 128) ?? null,
		optStr(body, "phone_number", 32) ?? null,
		plate ? normalizePlate(plate) : null,
		optStr(body, "purpose", 64) ?? null,
		validFrom,
		validUntil,
		g.issuedBy,
		g.issuedById,
	);
	const result = { visitor_id: visitorId, valid_from: validFrom, valid_until: validUntil };

	if (!g.issueCode) {
		await insertVisitor.run();
		return result;
	}

	for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
		const rand = random4();
		const digits = g.prefix + rand;
		// ห้ามชนกับ PIN ของลูกบ้าน เพราะ Keypad ส่งมาเป็น method PIN เหมือนกัน
		const pinClash = await env.DB.prepare("SELECT 1 FROM tb_credential WHERE project_id = ? AND cred_type = 'PIN' AND cred_hash = ?")
			.bind(projectId, await credentialHash(env.CRED_PEPPER, projectId, "PIN", digits))
			.first();
		if (pinClash) continue;

		const credentialId = crypto.randomUUID();
		const insertCode = env.DB.prepare(
			`INSERT INTO tb_credential (credential_id, project_id, visitor_id, cred_type, cred_hash, valid_from, valid_until)
			 VALUES (?, ?, ?, 'GUEST', ?, ?, ?)`,
		).bind(credentialId, projectId, visitorId, await credentialHash(env.CRED_PEPPER, projectId, "GUEST", digits), validFrom, validUntil);
		try {
			// batch = transaction: ถ้าโค้ดซ้ำ visitor ก็ไม่ถูกสร้าง
			await env.DB.batch([insertVisitor, insertCode]);
			// โค้ดจริงคืนให้ครั้งเดียวตอนสร้าง DB เก็บแค่ hash
			return { ...result, credential_id: credentialId, code: `${g.prefix}+${rand}` };
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
		}
	}
	throw new HttpError(409, "GUEST_CODE_UNAVAILABLE");
}

const VISITOR_COLS = `v.visitor_id, v.house_id, h.house_number, h.house_code, v.full_name, v.phone_number, v.license_plate,
	v.purpose, v.valid_from, v.valid_until, v.issued_by_type, v.issued_by_id, v.is_active, v.id_status,
	(v.is_active = 1 AND datetime('now') BETWEEN datetime(v.valid_from) AND datetime(v.valid_until)) AS is_valid_now`;

// houseId: undefined = ทุก visitor ในโครงการ, string = เฉพาะบ้านนั้น
export async function listVisitors(env: Env, projectId: string, houseId: string | undefined, onlyValid: boolean) {
	const where = ["v.project_id = ?"];
	const args: unknown[] = [projectId];
	if (houseId !== undefined) {
		where.push("v.house_id = ?");
		args.push(houseId);
	}
	if (onlyValid) where.push("v.is_active = 1 AND datetime(v.valid_until) >= datetime('now')");
	const { results } = await env.DB.prepare(
		`SELECT ${VISITOR_COLS} FROM tb_visitor v LEFT JOIN tb_house h ON h.house_id = v.house_id
		 WHERE ${where.join(" AND ")} ORDER BY v.create_date DESC LIMIT 500`,
	)
		.bind(...args)
		.all();
	return results;
}

// เพิกถอน visitor และ credential ทั้งหมดของ visitor นั้น; houseId บังคับให้เป็นของบ้านนั้นเท่านั้น
export async function revokeVisitor(env: Env, projectId: string, visitorId: string, houseId?: string) {
	const houseFilter = houseId === undefined ? "" : " AND house_id = ?";
	const args = houseId === undefined ? [visitorId, projectId] : [visitorId, projectId, houseId];
	const [visitor] = await env.DB.batch([
		env.DB.prepare(`UPDATE tb_visitor SET is_active = 0, id_status = 'REVOKED' WHERE visitor_id = ? AND project_id = ?${houseFilter}`).bind(
			...args,
		),
		env.DB.prepare(
			`UPDATE tb_credential SET is_active = 0, id_status = 'REVOKED'
			 WHERE visitor_id = ? AND project_id = ? AND visitor_id IN (SELECT visitor_id FROM tb_visitor WHERE id_status = 'REVOKED')`,
		).bind(visitorId, projectId),
	]);
	if (visitor.meta.changes === 0) throw new HttpError(404, "NOT_FOUND");
}
