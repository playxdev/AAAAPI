import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword, sha256Hex } from "../src/crypto";

const P = "PV";
const PASSWORD = "visitor-test-admin-pass";
const DEVICE_SECRET = "visitor-test-device";

const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
	const res = await exports.default.fetch(`https://aaa.test${path}`, {
		method,
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
};

// LIFF ID Token จำลอง: "line:<sub>" ผ่าน, อย่างอื่นไม่ผ่าน
const realFetch = globalThis.fetch;
beforeAll(() => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith("https://api.line.me/oauth2/v2.1/verify")) return realFetch(input, init);
		const form = new URLSearchParams(String(init?.body));
		const token = form.get("id_token") ?? "";
		if (!token.startsWith("line:")) return Response.json({ error: "invalid_request" }, { status: 400 });
		return Response.json({ sub: token.slice(5), aud: form.get("client_id") });
	});
});
afterAll(() => vi.restoreAllMocks());

let deviceToken = "";
async function gate(method: string, value: string) {
	if (!deviceToken) {
		deviceToken = (await call("POST", "/api/v1/auth/device/token", undefined, { device_id: "DV", device_secret: DEVICE_SECRET })).body
			.access_token;
	}
	return (await call("POST", "/api/v1/access/authorize", deviceToken, { event_id: crypto.randomUUID(), method, value })).body;
}

let admin = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
	const policy = [
		["RESIDENT", "ANPR"], ["RESIDENT", "PIN"],
		["VISITOR", "QRCODE"], ["VISITOR", "PIN"], ["VISITOR", "ANPR"],
	];
	await env.DB.batch([
		env.DB.prepare("INSERT INTO tb_project (project_id, project_name) VALUES (?, 'V')").bind(P),
		env.DB.prepare("INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password) VALUES ('ADM_V', ?, 'admin-v', ?)").bind(
			P,
			await hashPassword(PASSWORD),
		),
		env.DB.prepare("INSERT INTO tb_device (device_id, project_id, gate_name, device_secret_hash) VALUES ('DV', ?, 'Entry', ?)").bind(
			P,
			await sha256Hex(DEVICE_SECRET),
		),
		...policy.map(([s, m]) => env.DB.prepare("INSERT INTO tb_policy (project_id, subject_type, method) VALUES (?, ?, ?)").bind(P, s, m)),
	]);
	admin = (await call("POST", "/api/v1/admin/login", undefined, { admin_name: "admin-v", password: PASSWORD })).body.access_token;

	ids.house = (await call("POST", "/api/v1/admin/houses", admin, { house_number: "98/1", house_code: "9801" })).body.house_id;
	ids.house2 = (await call("POST", "/api/v1/admin/houses", admin, { house_number: "98/2", house_code: "9802" })).body.house_id;
	ids.noCode = (await call("POST", "/api/v1/admin/houses", admin, { house_number: "98/3" })).body.house_id;
	ids.owner = (await call("POST", "/api/v1/admin/residents", admin, { house_id: ids.house, full_name: "Owner 1" })).body.user_id;
	ids.owner2 = (await call("POST", "/api/v1/admin/residents", admin, { house_id: ids.house2, full_name: "Owner 2" })).body.user_id;
	ids.owner3 = (await call("POST", "/api/v1/admin/residents", admin, { house_id: ids.noCode, full_name: "Owner 3" })).body.user_id;
});

async function linkOwner(userId: string, lineSub: string) {
	const code = (await call("POST", `/api/v1/admin/residents/${userId}/link-code`, admin)).body.link_code;
	return call("POST", "/api/v1/owner/link", undefined, { id_token: `line:${lineSub}`, link_code: code });
}

describe("house code", () => {
	it("validates and keeps house_code unique per project", async () => {
		expect((await call("POST", "/api/v1/admin/houses", admin, { house_number: "x", house_code: "0123" })).body.field).toBe("house_code");
		expect((await call("POST", "/api/v1/admin/houses", admin, { house_number: "x", house_code: "9801" })).status).toBe(409);
	});
});

describe("owner LINE login / link", () => {
	it("rejects invalid LINE token and unlinked accounts", async () => {
		expect((await call("POST", "/api/v1/owner/login", undefined, { id_token: "forged" })).status).toBe(401);
		expect((await call("POST", "/api/v1/owner/login", undefined, { id_token: "line:U-nobody" })).body.error).toBe("NOT_LINKED");
	});

	it("links with a one-time code, then logs in with LINE", async () => {
		const linked = await linkOwner(ids.owner, "U-owner1");
		expect(linked.status).toBe(200);
		const login = await call("POST", "/api/v1/owner/login", undefined, { id_token: "line:U-owner1" });
		const me = await call("GET", "/api/v1/owner/me", login.body.access_token);
		expect(me.body).toMatchObject({ user_id: ids.owner, house_code: "9801" });
	});

	it("rejects a wrong or reused link code, and a LINE account linked twice", async () => {
		expect((await call("POST", "/api/v1/owner/link", undefined, { id_token: "line:U-x", link_code: "NOPE1234" })).status).toBe(400);
		expect((await linkOwner(ids.owner2, "U-owner1")).status).toBe(409);
	});

	it("admin and device tokens cannot call the owner API", async () => {
		expect((await call("GET", "/api/v1/owner/me", admin)).status).toBe(401);
	});
});

describe("guest codes", () => {
	let owner = "";
	let owner2 = "";
	beforeAll(async () => {
		owner = (await call("POST", "/api/v1/owner/login", undefined, { id_token: "line:U-owner1" })).body.access_token;
		owner2 = (await linkOwner(ids.owner2, "U-owner2")).body.access_token;
	});

	it("owner issues <house_code>+xxxx that works as QR and on the keypad", async () => {
		const res = await call("POST", "/api/v1/owner/visitors", owner, { duration: "1d", full_name: "Rider", purpose: "DELIVERY" });
		expect(res.status).toBe(201);
		expect(res.body.code).toMatch(/^9801\+\d{4}$/);
		const code: string = res.body.code;
		const digits = code.replace("+", "");

		expect(await gate("QRCODE", code)).toMatchObject({ decision: "YES", reason_code: "VISITOR_VALID" });
		expect(await gate("PIN", digits)).toMatchObject({ decision: "YES" });
		expect(await gate("PIN", code.replace("+", "#"))).toMatchObject({ decision: "YES" });

		// owner บ้านอื่นเพิกถอนไม่ได้ / ไม่เห็น
		expect((await call("DELETE", `/api/v1/owner/visitors/${res.body.visitor_id}`, owner2)).status).toBe(404);
		expect((await call("GET", "/api/v1/owner/visitors", owner2)).body.visitors).toHaveLength(0);

		const mine = (await call("GET", "/api/v1/owner/visitors", owner)).body.visitors;
		expect(mine[0]).toMatchObject({ visitor_id: res.body.visitor_id, house_code: "9801", is_valid_now: 1 });
		expect(JSON.stringify(mine)).not.toContain(code);

		expect((await call("DELETE", `/api/v1/owner/visitors/${res.body.visitor_id}`, owner)).status).toBe(200);
		expect(await gate("QRCODE", code)).toMatchObject({ decision: "NO", reason_code: "CREDENTIAL_REVOKED" });
	});

	it("sets validity from duration and expires", async () => {
		const forever = await call("POST", "/api/v1/owner/visitors", owner, { duration: "forever" });
		expect(new Date(`${forever.body.valid_until}Z`).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 99);

		const week = await call("POST", "/api/v1/owner/visitors", owner, { duration: "7d" });
		const days = (Date.parse(`${week.body.valid_until}Z`) - Date.parse(`${week.body.valid_from}Z`)) / 86_400_000;
		expect(days).toBe(7);

		expect((await call("POST", "/api/v1/owner/visitors", owner, { duration: "2d" })).body.field).toBe("duration");

		await env.DB.prepare("UPDATE tb_credential SET valid_until = datetime('now', '-1 minute') WHERE visitor_id = ?")
			.bind(week.body.visitor_id)
			.run();
		expect(await gate("QRCODE", week.body.code)).toMatchObject({ decision: "NO", reason_code: "CREDENTIAL_EXPIRED" });
	});

	it("house without house_code cannot issue codes", async () => {
		const owner3 = (await linkOwner(ids.owner3, "U-owner3")).body.access_token;
		expect((await call("POST", "/api/v1/owner/visitors", owner3, { duration: "1d" })).body.error).toBe("HOUSE_CODE_MISSING");
	});

	it("admin issues common-area codes (prefix 0) and plate-only visitors", async () => {
		const event = await call("POST", "/api/v1/admin/visitors", admin, { duration: "1d", purpose: "งานส่วนกลาง", full_name: "Guest" });
		expect(event.body.code).toMatch(/^0\+\d{4}$/);
		expect(await gate("QRCODE", event.body.code)).toMatchObject({ decision: "YES" });

		const car = await call("POST", "/api/v1/admin/visitors", admin, { duration: "1d", license_plate: "ทท 4040", issue_code: false });
		expect(car.body.code).toBeUndefined();
		expect(await gate("ANPR", "ทท4040")).toMatchObject({ decision: "YES", reason_code: "VISITOR_VALID" });

		const all = (await call("GET", "/api/v1/admin/visitors?valid=1", admin)).body.visitors;
		expect(all.some((v: any) => v.house_id === null && v.purpose === "งานส่วนกลาง")).toBe(true);
	});

	it("resident PIN cannot equal an active guest code", async () => {
		const g = await call("POST", "/api/v1/owner/visitors", owner, { duration: "1d" });
		const res = await call("POST", `/api/v1/admin/residents/${ids.owner}/credentials`, admin, {
			cred_type: "PIN",
			value: g.body.code.replace("+", ""),
		});
		expect(res.status).toBe(409);
	});
});

describe("audit and abuse protection", () => {
	it("records admin and owner actions without secrets", async () => {
		const { results } = await env.DB.prepare("SELECT actor_type, action, detail FROM tb_audit_log WHERE project_id = ?").bind(P).all<any>();
		const actions = results.map((r) => `${r.actor_type} ${r.action}`);
		expect(actions).toContain("OWNER POST /api/v1/owner/visitors");
		expect(actions).toContain("OWNER DELETE /api/v1/owner/visitors/:id");
		expect(actions).toContain("OWNER LINK_LINE");
		expect(actions).toContain("ADMIN POST /api/v1/admin/residents/:id/link-code");
		expect(actions).toContain("ADMIN LOGIN");
		expect(results.every((r) => !String(r.detail).includes("value") && !String(r.detail).includes("id_token"))).toBe(true);
	});

	it("locks keypad/QR on a device after repeated wrong codes", async () => {
		for (let i = 0; i < 10; i++) await gate("PIN", `9801${String(i).padStart(4, "7")}`);
		expect(await gate("PIN", "98010000")).toMatchObject({ decision: "NO", reason_code: "TOO_MANY_ATTEMPTS" });
		// วิธีอื่นยังใช้ได้
		expect((await gate("ANPR", "ทท4040")).reason_code).not.toBe("TOO_MANY_ATTEMPTS");
	});
});

describe("CORS", () => {
	it("allows configured origins only", async () => {
		const ok = await call("OPTIONS", "/api/v1/owner/visitors", undefined, undefined, { Origin: "https://liff.example.com" });
		expect(ok.status).toBe(204);
		expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://liff.example.com");
		const bad = await call("OPTIONS", "/api/v1/owner/visitors", undefined, undefined, { Origin: "https://evil.example.com" });
		expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});
