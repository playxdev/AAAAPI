import { auditTarget, writeAudit } from "./audit";
import { JWT_ISS, sha256Hex, signJwt, verifyJwt } from "./crypto";
import { issueGuest, listVisitors, revokeVisitor } from "./guest";
import { type Body, errorResponse, HttpError, isStr, isUniqueViolation, json, readJson } from "./http";

const OWNER_AUD = "aaa-owner";
const OWNER_TTL_SEC = 60 * 60;
const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

// ตรวจ LIFF ID Token กับ LINE; คืน LINE userId (sub) เมื่อออกให้ channel ของเราเท่านั้น
async function verifyLineIdToken(env: Env, idToken: string): Promise<string | null> {
	const res = await fetch(LINE_VERIFY_URL, {
		method: "POST",
		body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_CHANNEL_ID }),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { sub?: unknown; aud?: unknown };
	return data.aud === env.LINE_CHANNEL_ID && typeof data.sub === "string" ? data.sub : null;
}

async function issueOwnerToken(env: Env, userId: string, projectId: string) {
	const now = Math.floor(Date.now() / 1000);
	const token = await signJwt(env.JWT_SECRET, {
		iss: JWT_ISS,
		aud: OWNER_AUD,
		sub: userId,
		pid: projectId,
		scope: "owner",
		iat: now,
		exp: now + OWNER_TTL_SEC,
	});
	return { access_token: token, token_type: "Bearer", expires_in: OWNER_TTL_SEC };
}

// POST /api/v1/owner/login  { id_token } -> JWT; ยังไม่ผูกบัญชี -> 403 NOT_LINKED
async function login(req: Request, env: Env): Promise<Response> {
	const body = await readJson(req);
	if (!isStr(body?.id_token, 4096)) return json({ error: "BAD_REQUEST" }, 400);
	const lineUserId = await verifyLineIdToken(env, body.id_token);
	if (!lineUserId) return json({ error: "INVALID_LINE_TOKEN" }, 401);

	const user = await env.DB.prepare("SELECT user_id, project_id FROM tb_user WHERE line_user_id = ? AND is_active = 1")
		.bind(lineUserId)
		.first<{ user_id: string; project_id: string }>();
	if (!user) return json({ error: "NOT_LINKED" }, 403);

	await writeAudit(env, user.project_id, "OWNER", user.user_id, "LOGIN", user.user_id, {});
	return json(await issueOwnerToken(env, user.user_id, user.project_id));
}

// POST /api/v1/owner/link  { id_token, link_code } -> ผูก LINE กับลูกบ้าน แล้วคืน JWT
async function link(req: Request, env: Env): Promise<Response> {
	const body = await readJson(req);
	if (!isStr(body?.id_token, 4096) || !isStr(body?.link_code, 32)) return json({ error: "BAD_REQUEST" }, 400);
	const lineUserId = await verifyLineIdToken(env, body.id_token);
	if (!lineUserId) return json({ error: "INVALID_LINE_TOKEN" }, 401);

	const user = await env.DB.prepare(
		`SELECT user_id, project_id FROM tb_user
		 WHERE link_code_hash = ? AND link_code_expires > datetime('now') AND is_active = 1`,
	)
		.bind(await sha256Hex(body.link_code.trim().toUpperCase()))
		.first<{ user_id: string; project_id: string }>();
	if (!user) return json({ error: "INVALID_LINK_CODE" }, 400);

	try {
		await env.DB.prepare("UPDATE tb_user SET line_user_id = ?, link_code_hash = NULL, link_code_expires = NULL WHERE user_id = ?")
			.bind(lineUserId, user.user_id)
			.run();
	} catch (err) {
		if (isUniqueViolation(err)) return json({ error: "LINE_ALREADY_LINKED" }, 409);
		throw err;
	}
	await writeAudit(env, user.project_id, "OWNER", user.user_id, "LINK_LINE", user.user_id, {});
	return json(await issueOwnerToken(env, user.user_id, user.project_id));
}

interface Owner {
	user_id: string;
	project_id: string;
	full_name: string;
	house_id: string | null;
	house_number: string | null;
	house_code: string | null;
}

interface Ctx {
	env: Env;
	owner: Owner;
	id: string;
	body: Body;
	url: URL;
}

function requireHouse(owner: Owner): string {
	if (!owner.house_id) throw new HttpError(409, "NO_HOUSE");
	return owner.house_id;
}

async function me(c: Ctx) {
	return json(c.owner);
}

// ลูกบ้านเห็นเฉพาะ visitor ของบ้านตัวเอง
async function ownerListVisitors(c: Ctx) {
	const visitors = await listVisitors(c.env, c.owner.project_id, requireHouse(c.owner), c.url.searchParams.get("valid") === "1");
	return json({ visitors });
}

// ออก Guest Code "<house_code>+xxxx" ใช้ได้ทั้ง QR และ Keypad
async function ownerCreateVisitor(c: Ctx) {
	const houseId = requireHouse(c.owner);
	if (!c.owner.house_code) throw new HttpError(409, "HOUSE_CODE_MISSING");
	const result = await issueGuest(
		c.env,
		c.owner.project_id,
		{ houseId, prefix: c.owner.house_code, issuedBy: "OWNER", issuedById: c.owner.user_id, issueCode: true },
		c.body,
	);
	return json(result, 201);
}

async function ownerRevokeVisitor(c: Ctx) {
	await revokeVisitor(c.env, c.owner.project_id, c.id, requireHouse(c.owner));
	return json({ visitor_id: c.id, id_status: "REVOKED" });
}

const route = (method: string, path: string, handler: (c: Ctx) => Promise<Response>) => ({
	method,
	pattern: new URLPattern({ pathname: `/api/v1/owner${path}` }),
	handler,
});

const ROUTES = [
	route("GET", "/me", me),
	route("GET", "/visitors", ownerListVisitors),
	route("POST", "/visitors", ownerCreateVisitor),
	route("DELETE", "/visitors/:id", ownerRevokeVisitor),
];

export async function handleOwner(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	if (req.method === "POST" && url.pathname === "/api/v1/owner/login") return login(req, env);
	if (req.method === "POST" && url.pathname === "/api/v1/owner/link") return link(req, env);

	const match = ROUTES.map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url) : null })).find((x) => x.m);
	if (!match?.m) return json({ error: "NOT_FOUND" }, 404);

	const auth = req.headers.get("Authorization") ?? "";
	const claims = auth.startsWith("Bearer ") ? await verifyJwt(env.JWT_SECRET, auth.slice(7), JWT_ISS, OWNER_AUD) : null;
	// เช็ค DB ทุกครั้ง: ลูกบ้านที่ถูกปิด / ย้ายบ้าน มีผลทันที
	const owner =
		claims &&
		(await env.DB.prepare(
			`SELECT u.user_id, u.project_id, u.full_name, u.house_id, h.house_number, h.house_code
			 FROM tb_user u LEFT JOIN tb_house h ON h.house_id = u.house_id
			 WHERE u.user_id = ? AND u.is_active = 1 AND u.line_user_id IS NOT NULL`,
		)
			.bind(claims.sub)
			.first<Owner>());
	if (!claims || !owner || owner.project_id !== claims.pid) return json({ error: "UNAUTHORIZED" }, 401);

	const body = req.method === "POST" ? await readJson(req) : {};
	if (!body) return json({ error: "BAD_REQUEST" }, 400);

	try {
		const id = decodeURIComponent(match.m.pathname.groups.id ?? "");
		const res = await match.r.handler({ env, owner, id, body, url });
		if (req.method !== "GET" && res.ok) {
			const action = `${req.method} ${match.r.pattern.pathname}`;
			await writeAudit(env, owner.project_id, "OWNER", owner.user_id, action, await auditTarget(res, id), body);
		}
		return res;
	} catch (err) {
		return errorResponse(err);
	}
}
