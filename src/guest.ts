import { credentialHash, isThaiProvince, normalizePlate, normalizeProvince, PLATE_RE } from "./authorize";
import { badField, type Body, HttpError, isUniqueViolation, notFound, optBool, optStr, reqEnum } from "./http";
import type { ActorType } from "./audit";

// ระยะเวลาที่เลือกได้ (วัน); forever = 100 ปี
export const DURATION_DAYS: Record<string, number> = { "1d": 1, "7d": 7, "14d": 14, "30d": 30, "1y": 365, forever: 36500 };

// Guest Code ของงานส่วนกลาง (ไม่มีบ้าน) ใช้ tb_project.common_area_code (ค่าเริ่มต้น 0000) เช่น 0000+1234
// ต้องขึ้นต้นด้วย 0 จึงไม่ชนกับ house_code (ห้ามขึ้นต้นด้วย 0)
export const DEFAULT_COMMON_AREA_CODE = "0000";
export const COMMON_AREA_CODE_RE = /^0\d{0,5}$/;
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
	const car = visitorVehicle(body);
	const now = new Date();
	const validFrom = sqlTime(now);
	const validUntil = sqlTime(new Date(now.getTime() + days * 86_400_000));
	const visitorId = crypto.randomUUID();

	const insertVisitor = env.DB.prepare(
		`INSERT INTO tb_visitor (visitor_id, project_id, house_id, full_name, phone_number, license_plate, province, brand, color, purpose,
		   valid_from, valid_until, issued_by_type, issued_by_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		visitorId,
		projectId,
		g.houseId,
		optStr(body, "full_name", 128) ?? null,
		optStr(body, "phone_number", 32) ?? null,
		car.license_plate,
		car.province,
		car.brand,
		car.color,
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

// รถของผู้มาติดต่อ (ไม่บังคับ) กติกาเดียวกับรถของบ้าน; จังหวัด / ยี่ห้อ / สี เก็บเมื่อมีทะเบียนเท่านั้น
function visitorVehicle(body: Body) {
	const raw = optStr(body, "license_plate", 32);
	const plate = raw ? normalizePlate(raw) : null;
	if (plate && !PLATE_RE.test(plate)) throw badField("license_plate");
	const province = plate ? normalizeProvince(optStr(body, "province", 64)) : null;
	if (province && !isThaiProvince(province)) throw badField("province");
	return {
		license_plate: plate,
		province,
		brand: plate ? (optStr(body, "brand", 64) ?? null) : null,
		color: plate ? (optStr(body, "color", 32) ?? null) : null,
	};
}

// แก้ข้อมูลผู้มาติดต่อ (ชื่อ / โทร / วัตถุประสงค์ / รถ / สถานะ) ไม่เปลี่ยนบ้าน อายุ และ Guest Code
// is_active: false = เพิกถอน, true = ใช้ได้อีกครั้ง (Guest Code เดิมกลับมาใช้ได้ถ้ายังไม่หมดอายุ)
export async function updateVisitor(env: Env, projectId: string, visitorId: string, body: Body) {
	const active = optBool(body, "is_active");
	const sets: Record<string, unknown> = {
		full_name: optStr(body, "full_name", 128),
		phone_number: optStr(body, "phone_number", 32),
		purpose: optStr(body, "purpose", 64),
		...(body.license_plate !== undefined && visitorVehicle(body)),
		...(active !== undefined && { is_active: active ? 1 : 0, id_status: active ? "ACTIVE" : "REVOKED" }),
	};
	const cols = Object.keys(sets).filter((k) => sets[k] !== undefined);
	if (cols.length === 0) throw badField("body");
	const update = env.DB.prepare(
		`UPDATE tb_visitor SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE visitor_id = ? AND project_id = ?`,
	).bind(...cols.map((k) => sets[k]), visitorId, projectId);
	// Guest Code ตามสถานะของ visitor
	const codes =
		active === undefined
			? []
			: [
					env.DB.prepare("UPDATE tb_credential SET is_active = ?, id_status = ? WHERE visitor_id = ? AND project_id = ?").bind(
						active ? 1 : 0,
						active ? "ACTIVE" : "REVOKED",
						visitorId,
						projectId,
					),
				];
	const [res] = await env.DB.batch([update, ...codes]);
	if (res.meta.changes === 0) throw notFound();
}

const VISITOR_COLS = `v.visitor_id, v.house_id, h.house_number, h.house_code, v.full_name, v.phone_number, v.license_plate, v.province, v.brand, v.color,
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

// เพิกถอน visitor และ credential ทั้งหมดของ visitor นั้น; houseId / issuedById = เฉพาะของบ้านนั้น / ที่คนนั้นออกเท่านั้น
export async function revokeVisitor(env: Env, projectId: string, visitorId: string, houseId?: string, issuedById?: string) {
	let houseFilter = houseId === undefined ? "" : " AND house_id = ?";
	const args: unknown[] = houseId === undefined ? [visitorId, projectId] : [visitorId, projectId, houseId];
	if (issuedById !== undefined) {
		houseFilter += " AND issued_by_type = 'OWNER' AND issued_by_id = ?";
		args.push(issuedById);
	}
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
