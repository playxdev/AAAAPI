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
		["RESIDENT", "ANPR"], ["RESIDENT", "PIN"], ["RESIDENT", "QRCODE"],
		["VISITOR", "QRCODE"], ["VISITOR", "PIN"], ["VISITOR", "ANPR"],
	];
	await env.DB.batch([
		env.DB.prepare("INSERT INTO tb_project (project_id, project_name, project_code) VALUES (?, 'V', 'VILL-0001')").bind(P),
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
	admin = (await call("POST", "/api/v1/admin/login", undefined, { project_code: "VILL-0001", admin_name: "admin-v", password: PASSWORD })).body.access_token;

	ids.house = (await call("POST", "/api/v1/admin/houses", admin, { house_number: "98/1", house_code: "9801" })).body.house_id;
	ids.house2 = (await call("POST", "/api/v1/admin/houses", admin, { house_number: "98/2", house_code: "9802" })).body.house_id;
	ids.noCode = (await call("POST", "/api/v1/admin/houses", admin, { house_number: "98/3" })).body.house_id;
	ids.owner = (await call("POST", `/api/v1/admin/houses/${ids.house}/contacts`, admin, { full_name: "Owner 1" })).body.user_id;
	ids.owner2 = (await call("POST", `/api/v1/admin/houses/${ids.house2}/contacts`, admin, { full_name: "Owner 2" })).body.user_id;
	ids.owner3 = (await call("POST", `/api/v1/admin/houses/${ids.noCode}/contacts`, admin, { full_name: "Owner 3" })).body.user_id;
});

async function linkOwner(userId: string, lineSub: string) {
	const code = (await call("POST", `/api/v1/admin/contacts/${userId}/link-code`, admin)).body.link_code;
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

		// admin can set the status back: the same Guest Code works again (and revoke it once more)
		const status = (is_active: boolean) => call("PATCH", `/api/v1/admin/visitors/${res.body.visitor_id}`, admin, { is_active });
		expect((await status(true)).status).toBe(200);
		expect(await gate("QRCODE", code)).toMatchObject({ decision: "YES" });
		await status(false);
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
		expect(event.body.code).toMatch(/^0000\+\d{4}$/); // project common_area_code (default 0000)
		expect(await gate("QRCODE", event.body.code)).toMatchObject({ decision: "YES" });

		const car = await call("POST", "/api/v1/admin/visitors", admin, { duration: "1d", license_plate: "ทท 4040", province: "กทม", brand: "HONDA", color: "RED", issue_code: false });
		expect((await call("POST", "/api/v1/admin/visitors", admin, { duration: "1d", license_plate: "ABC", issue_code: false })).body.field).toBe("license_plate");
		expect(car.body.code).toBeUndefined();
		expect(await gate("ANPR", "ทท4040")).toMatchObject({ decision: "YES", reason_code: "VISITOR_VALID" });

		const all = (await call("GET", "/api/v1/admin/visitors?valid=1", admin)).body.visitors;
		expect(all.some((v: any) => v.house_id === null && v.purpose === "งานส่วนกลาง")).toBe(true);
		expect(all.find((v: any) => v.license_plate === "ทท4040")).toMatchObject({ province: "กรุงเทพมหานคร", brand: "HONDA", color: "RED" });

		// edit a visitor (not its house / validity / code); provinces are Thai only
		const edit = (body: object) => call("PATCH", `/api/v1/admin/visitors/${car.body.visitor_id}`, admin, body);
		expect((await edit({ full_name: "แขกบ้าน", license_plate: "ทท 5050", province: "เชียงใหม่", color: "BLUE" })).status).toBe(200);
		expect((await edit({ license_plate: "ทท 5050", province: "Bangkok" })).body.field).toBe("province");
		expect((await edit({})).status).toBe(400);
		const edited = (await call("GET", "/api/v1/admin/visitors", admin)).body.visitors.find((v: any) => v.visitor_id === car.body.visitor_id);
		expect(edited).toMatchObject({ full_name: "แขกบ้าน", license_plate: "ทท5050", province: "เชียงใหม่", color: "BLUE" });
		expect(await gate("ANPR", "ทท5050")).toMatchObject({ decision: "YES" });
	});

	it("a vacant house cannot issue guest codes, and its existing codes stop working", async () => {
		const g = await call("POST", "/api/v1/owner/visitors", owner2, { duration: "1d" });
		await call("PATCH", `/api/v1/admin/houses/${ids.house2}`, admin, { occupancy_status: "VACANT" });
		expect(await gate("QRCODE", g.body.code)).toMatchObject({ decision: "NO", reason_code: "HOUSE_VACANT" });
		expect((await call("POST", "/api/v1/owner/visitors", owner2, { duration: "1d" })).body.error).toBe("HOUSE_VACANT");
		expect((await call("POST", "/api/v1/admin/visitors", admin, { duration: "1d", house_id: ids.house2 })).body.error).toBe("HOUSE_VACANT");
		await call("PATCH", `/api/v1/admin/houses/${ids.house2}`, admin, { occupancy_status: "OCCUPIED" });
		expect(await gate("QRCODE", g.body.code)).toMatchObject({ decision: "YES" });
	});

	it("resident PIN cannot equal an active guest code", async () => {
		const g = await call("POST", "/api/v1/owner/visitors", owner, { duration: "1d" });
		// Guest Code 9801+xxxx และ PIN 9801 + xxxx อยู่ในชุดตัวเลขเดียวกัน
		const res = await call("POST", `/api/v1/admin/houses/${ids.house}/credentials`, admin, {
			cred_type: "PIN",
			value: g.body.code.split("+")[1],
		});
		expect(res.status).toBe(409);
	});
});

describe("house members via LINE", () => {
	let owner = "";
	let fam = "";
	beforeAll(async () => {
		owner = (await call("POST", "/api/v1/owner/login", undefined, { id_token: "line:U-owner1" })).body.access_token;
	});

	it("owner sees the house without the project code and invites a member", async () => {
		const house = await call("GET", "/api/v1/owner/house", owner);
		expect(house.body).toMatchObject({ role: "OWNER", house_code: "9801", ref: "VILL-0001-9801-01" });
		expect(JSON.stringify(house.body)).not.toContain("VILL-0001\"");
		expect(house.body.project_id).toBeUndefined();

		const m = await call("POST", "/api/v1/owner/members", owner, { full_name: "ลูกสาว", role: "FAMILY" });
		expect(m.status).toBe(201);
		expect(m.body).toMatchObject({ role: "FAMILY", ref: "VILL-0001-9801-02" });
		expect((await call("POST", "/api/v1/owner/members", owner, { full_name: "x", role: "OWNER" })).status).toBe(400);
		const linked = await call("POST", "/api/v1/owner/link", undefined, { id_token: "line:U-fam1", link_code: m.body.link_code });
		fam = linked.body.access_token;
		expect((await call("GET", "/api/v1/owner/me", fam)).body).toMatchObject({ role: "FAMILY", house_code: "9801" });

		// only the owner manages members
		expect((await call("POST", "/api/v1/owner/members", fam, { full_name: "y" })).body.error).toBe("OWNER_ONLY");
		expect((await call("DELETE", `/api/v1/owner/members/${ids.owner}`, owner)).status).toBe(404);
	});

	it("members create PIN / QR with the house code; RFID is admin only; each deletes only their own", async () => {
		const pin = await call("POST", "/api/v1/owner/credentials", fam, { cred_type: "PIN", label: "pin ส่งของ" });
		expect(pin.body.value).toMatch(/^9801\d{4}$/);
		expect(await gate("PIN", pin.body.value)).toMatchObject({ decision: "YES" });
		const qr = await call("POST", "/api/v1/owner/credentials", fam, { cred_type: "QRCODE", label: "QR เพื่อน" });
		expect(qr.body.value).toMatch(/^9801[A-HJ-NP-Z2-9]{20}$/);
		expect(await gate("QRCODE", qr.body.value)).toMatchObject({ decision: "YES" });
		expect((await call("POST", "/api/v1/owner/credentials", fam, { cred_type: "RFID", value: "CARD-X" })).body.field).toBe("cred_type");

		const mine = (await call("GET", "/api/v1/owner/house", fam)).body.credentials.find((c: any) => c.credential_id === pin.body.credential_id);
		expect(mine).toMatchObject({ label: "pin ส่งของ", mine: true });
		// only the creator edits validity; the owner may still rename anything in the house
		expect((await call("PATCH", `/api/v1/owner/credentials/${pin.body.credential_id}`, owner, { duration: "7d" })).status).toBe(404);
		expect((await call("PATCH", `/api/v1/owner/credentials/${pin.body.credential_id}`, owner, { label: "x" })).status).toBe(200);
		expect((await call("PATCH", `/api/v1/owner/credentials/${pin.body.credential_id}`, fam, { label: "pin แม่บ้าน" })).status).toBe(200);
		expect((await call("DELETE", `/api/v1/owner/credentials/${pin.body.credential_id}`, owner)).status).toBe(404);
		expect((await call("DELETE", `/api/v1/owner/credentials/${pin.body.credential_id}`, fam)).status).toBe(200);
		expect(await gate("PIN", pin.body.value)).toMatchObject({ decision: "NO", reason_code: "CREDENTIAL_REVOKED" });
		// short names belong to the house: the owner names anything in the house (incl. admin-added cards / vehicles), members only their own
		const rfid = await call("POST", `/api/v1/admin/houses/${ids.house}/credentials`, admin, { cred_type: "RFID", value: "CARD-9801", duration: "forever" });
		expect((await call("PATCH", `/api/v1/owner/credentials/${rfid.body.credential_id}`, owner, { label: "บัตรแม่" })).status).toBe(200);
		expect((await call("PATCH", `/api/v1/owner/credentials/${rfid.body.credential_id}`, owner, { label: "x", duration: "1d" })).status).toBe(404);
		expect((await call("PATCH", `/api/v1/owner/credentials/${rfid.body.credential_id}`, fam, { label: "x" })).status).toBe(404);
		const car = await call("POST", `/api/v1/admin/houses/${ids.house}/vehicles`, admin, { license_plate: "บบ 9801" });
		expect((await call("PATCH", `/api/v1/owner/vehicles/${car.body.vehicle_id}`, owner, { label: "รถพ่อ" })).status).toBe(200);
		expect((await call("PATCH", `/api/v1/owner/vehicles/${car.body.vehicle_id}`, fam, { label: "x" })).body.error).toBe("OWNER_ONLY");
		// admin editing the vehicle without a label keeps the owner's name
		await call("PATCH", `/api/v1/admin/vehicles/${car.body.vehicle_id}`, admin, { license_plate: "บบ 9801", color: "RED" });
		const house = (await call("GET", "/api/v1/owner/house", fam)).body;
		expect(house.vehicles.find((v: any) => v.vehicle_id === car.body.vehicle_id).label).toBe("รถพ่อ");
		expect(house.credentials.find((x: any) => x.credential_id === rfid.body.credential_id).label).toBe("บัตรแม่");

		// admin may delete anything in the project
		expect((await call("DELETE", `/api/v1/admin/credentials/${qr.body.credential_id}`, admin)).status).toBe(200);
	});

	it("caps active PIN per house at 20", async () => {
		const res = [];
		for (let i = 0; i < 21; i++) res.push((await call("POST", "/api/v1/owner/credentials", owner, { cred_type: "PIN" })).body);
		expect(res.slice(0, 20).filter((r) => !r.value)).toEqual([]);
		expect(res[20]).toMatchObject({ error: "LIMIT_REACHED" });
		await call("DELETE", `/api/v1/owner/credentials/${res[0].credential_id}`, owner);
		expect((await call("POST", "/api/v1/owner/credentials", owner, { cred_type: "PIN" })).status).toBe(201);
	});

	it("guest codes: every member issues, each revokes only their own", async () => {
		const g = await call("POST", "/api/v1/owner/visitors", fam, { duration: "1d" });
		expect(g.status).toBe(201);
		expect((await call("DELETE", `/api/v1/owner/visitors/${g.body.visitor_id}`, owner)).status).toBe(404);
		expect((await call("DELETE", `/api/v1/owner/visitors/${g.body.visitor_id}`, fam)).status).toBe(200);
	});

	it("admin moves the owner role; the old owner becomes a resident and keeps LINE", async () => {
		const famId = (await call("GET", "/api/v1/owner/me", fam)).body.user_id;
		expect((await call("PATCH", `/api/v1/admin/contacts/${famId}`, admin, { role: "OWNER" })).status).toBe(200);
		expect((await call("GET", "/api/v1/owner/me", fam)).body.role).toBe("OWNER");
		expect((await call("GET", "/api/v1/owner/me", owner)).body.role).toBe("RESIDENT");
		await call("PATCH", `/api/v1/admin/contacts/${ids.owner}`, admin, { role: "OWNER" });
	});
});

describe("audit and abuse protection", () => {
	it("records admin and owner actions without secrets", async () => {
		const { results } = await env.DB.prepare("SELECT actor_type, action, detail FROM tb_audit_log WHERE project_id = ?").bind(P).all<any>();
		const actions = results.map((r) => `${r.actor_type} ${r.action}`);
		expect(actions).toContain("OWNER POST /api/v1/owner/visitors");
		expect(actions).toContain("OWNER DELETE /api/v1/owner/visitors/:id");
		expect(actions).toContain("OWNER LINK_LINE");
		expect(actions).toContain("ADMIN POST /api/v1/admin/contacts/:id/link-code");
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
