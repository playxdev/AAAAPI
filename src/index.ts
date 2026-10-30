import { decide, METHODS, normalizePlate, type Decision, type Method } from "./authorize";
import { handleAdmin } from "./admin";
import { handleOwner } from "./owner";
import { JWT_ISS, safeEqual, sha256Hex, signJwt, verifyJwt } from "./crypto";
import { isStr, json, readJson } from "./http";

const JWT_AUD = "aaa-device";
const TOKEN_TTL_SEC = 15 * 60;
// กันสุ่ม PIN / Guest Code: ผิดเกิน N ครั้งใน 5 นาทีต่ออุปกรณ์ -> ปฏิเสธ PIN/QR ของอุปกรณ์นั้นชั่วคราว
const MAX_FAILED_CODES = 10;
const FAILED_CODE_WINDOW = "-5 minutes";

async function tooManyFailedCodes(env: Env, deviceId: string): Promise<boolean> {
	const failed = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM tb_access_log
		 WHERE device_id = ? AND timestamp > datetime('now', ?) AND reason_code = 'UNKNOWN_CREDENTIAL'`,
	)
		.bind(deviceId, FAILED_CODE_WINDOW)
		.first<number>("n");
	return (failed ?? 0) >= MAX_FAILED_CODES;
}

interface DeviceRow {
	project_id: string;
	direction: string | null;
	device_secret_hash: string | null;
}

const getActiveDevice = (env: Env, deviceId: string) =>
	env.DB.prepare(
		"SELECT project_id, direction, device_secret_hash FROM tb_device WHERE device_id = ? AND is_active = 1 AND id_status = 'ACTIVE'",
	)
		.bind(deviceId)
		.first<DeviceRow>();

// POST /api/v1/auth/device/token  { device_id, device_secret } -> JWT อายุสั้น
async function issueDeviceToken(req: Request, env: Env): Promise<Response> {
	const body = await readJson(req);
	if (!isStr(body?.device_id, 128) || !isStr(body?.device_secret, 256)) return json({ error: "BAD_REQUEST" }, 400);

	const device = await getActiveDevice(env, body.device_id);
	const hash = await sha256Hex(body.device_secret);
	if (!device?.device_secret_hash || !safeEqual(hash, device.device_secret_hash)) {
		return json({ error: "INVALID_DEVICE" }, 401);
	}

	const now = Math.floor(Date.now() / 1000);
	const token = await signJwt(env.JWT_SECRET, {
		iss: JWT_ISS,
		aud: JWT_AUD,
		sub: body.device_id,
		pid: device.project_id,
		scope: "access:authorize",
		iat: now,
		exp: now + TOKEN_TTL_SEC,
	});
	await env.DB.prepare("UPDATE tb_device SET last_seen = CURRENT_TIMESTAMP WHERE device_id = ?").bind(body.device_id).run();
	return json({ access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_SEC });
}

interface LogRow {
	project_id: string;
	decision: Decision["decision"];
	reason_code: string;
	allowed_methods: string | null;
	policy_version: number | null;
}

// POST /api/v1/access/authorize  { event_id, method, value } -> YES / NO / ERROR
async function authorize(req: Request, env: Env): Promise<Response> {
	const auth = req.headers.get("Authorization") ?? "";
	const claims = auth.startsWith("Bearer ") ? await verifyJwt(env.JWT_SECRET, auth.slice(7), JWT_ISS, JWT_AUD) : null;
	// เช็ค DB ทุกครั้ง เพื่อให้การเพิกถอนอุปกรณ์มีผลทันที ไม่ต้องรอ token หมดอายุ
	const device = claims && (await getActiveDevice(env, claims.sub));
	if (!claims || !device || device.project_id !== claims.pid) return json({ error: "UNAUTHORIZED" }, 401);

	const body = await readJson(req);
	const method = body?.method as Method;
	if (!isStr(body?.event_id, 128) || !METHODS.includes(method) || !isStr(body?.value, 256)) {
		return json({ error: "BAD_REQUEST" }, 400);
	}
	const eventId = body.event_id;
	const projectId = device.project_id;

	// Idempotency: event_id เดิมได้คำตอบเดิม ไม่ตัดสินซ้ำ
	const prev = await env.DB.prepare(
		"SELECT project_id, decision, reason_code, allowed_methods, policy_version FROM tb_access_log WHERE log_id = ?",
	)
		.bind(eventId)
		.first<LogRow>();
	if (prev) {
		if (prev.project_id !== projectId) return json({ error: "EVENT_ID_CONFLICT" }, 409);
		return respond(eventId, prev.decision, prev.reason_code, prev.allowed_methods?.split(",").filter(Boolean) ?? [], prev.policy_version);
	}

	let result: Decision;
	let policyVersion: number | null = null;
	try {
		policyVersion = await env.DB.prepare("SELECT policy_version FROM tb_project WHERE project_id = ?")
			.bind(projectId)
			.first<number>("policy_version");
		const locked = (method === "PIN" || method === "QRCODE") && (await tooManyFailedCodes(env, claims.sub));
		result = locked
			? { decision: "NO", reason_code: "TOO_MANY_ATTEMPTS", allowed_methods: [] }
			: await decide(env, projectId, method, body.value);
	} catch (err) {
		console.error("authorize failed", eventId, err);
		result = { decision: "ERROR", reason_code: "INTERNAL_ERROR", allowed_methods: [] };
	}

	try {
		await env.DB.prepare(
			`INSERT INTO tb_access_log
			   (log_id, project_id, device_id, license_plate, access_type, user_type, is_success, id_status,
			    method, decision, reason_code, allowed_methods, policy_version, credential_ref)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(log_id) DO NOTHING`,
		)
			.bind(
				eventId,
				projectId,
				claims.sub,
				method === "ANPR" ? normalizePlate(body.value) : null,
				device.direction,
				result.subject ?? "UNKNOWN",
				result.decision === "YES" ? 1 : 0,
				result.decision,
				method,
				result.decision,
				result.reason_code,
				result.allowed_methods.join(","),
				policyVersion,
				result.credential_ref ?? null,
			)
			.run();
	} catch (err) {
		// บันทึก audit ไม่ได้ = ไม่อนุญาต (fail closed)
		console.error("access log failed", eventId, err);
		result = { decision: "ERROR", reason_code: "LOG_FAILED", allowed_methods: [] };
	}

	return respond(eventId, result.decision, result.reason_code, result.allowed_methods, policyVersion);
}

const respond = (
	eventId: string,
	decision: Decision["decision"],
	reason_code: string,
	allowed_methods: string[],
	policy_version: number | null,
) => json({ event_id: eventId, decision, reason_code, allowed_methods, policy_version }, decision === "ERROR" ? 500 : 200);

// API ที่เรียกจาก browser (Admin WebApp บน Pages, LINE LIFF) ต้องมี CORS
const BROWSER_API_PREFIXES = ["/api/v1/admin/", "/api/v1/owner/"];

function withCors(req: Request, env: Env, res: Response): Response {
	const origin = req.headers.get("Origin");
	const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
	if (origin && allowed.includes(origin)) {
		res.headers.set("Access-Control-Allow-Origin", origin);
		res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
		res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
		res.headers.set("Access-Control-Max-Age", "86400");
	}
	res.headers.append("Vary", "Origin");
	return res;
}

async function route(req: Request, env: Env, pathname: string): Promise<Response> {
	if (req.method === "POST" && pathname === "/api/v1/auth/device/token") return issueDeviceToken(req, env);
	if (req.method === "POST" && pathname === "/api/v1/access/authorize") return authorize(req, env);
	if (pathname.startsWith("/api/v1/admin/")) return handleAdmin(req, env);
	if (pathname.startsWith("/api/v1/owner/")) return handleOwner(req, env);
	return json({ error: "NOT_FOUND" }, 404);
}

export default {
	async fetch(req, env): Promise<Response> {
		const { pathname } = new URL(req.url);
		if (!BROWSER_API_PREFIXES.some((p) => pathname.startsWith(p))) return route(req, env, pathname);
		if (req.method === "OPTIONS") return withCors(req, env, new Response(null, { status: 204 }));
		return withCors(req, env, await route(req, env, pathname));
	},
} satisfies ExportedHandler<Env>;
