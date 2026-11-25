import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, sha256Hex } from "../src/crypto";

const PASSWORD = "correct-horse-battery";
const DEVICE_SECRET = "admin-test-device-secret";

const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
	const res = await exports.default.fetch(`https://aaa.test${path}`, {
		method,
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, any> };
};

// admin-a อยู่โครงการ PRJA-0001, admin-b อยู่ PRJB-0001
async function login(name: string, password = PASSWORD, project_code = name === "admin-b" ? "PRJB-0001" : "PRJA-0001") {
	return call("POST", "/api/v1/admin/login", undefined, { project_code, admin_name: name, password });
}

async function authorize(method: string, value: string, province?: string) {
	const tok = await call("POST", "/api/v1/auth/device/token", undefined, { device_id: "DA", device_secret: DEVICE_SECRET });
	return (await call("POST", "/api/v1/access/authorize", tok.body.access_token, { event_id: crypto.randomUUID(), method, value, province })).body;
}

beforeAll(async () => {
	const hash = await hashPassword(PASSWORD);
	const policy = [
		["RESIDENT", "ANPR"], ["RESIDENT", "RFID"], ["RESIDENT", "PIN"], ["RESIDENT", "QRCODE"],
		["RESIDENT_OVERDUE", "RFID"], ["RESIDENT_OVERDUE", "PIN"],
	];
	await env.DB.batch([
		env.DB.prepare("INSERT INTO tb_project (project_id, project_name, project_code) VALUES ('PA', 'A', 'PRJA-0001'), ('PB', 'B', 'PRJB-0001')"),
		env.DB.prepare(
			"INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password) VALUES ('ADM_A', 'PA', 'admin-a', ?), ('ADM_B', 'PB', 'admin-b', ?)",
		).bind(hash, hash),
		env.DB.prepare("INSERT INTO tb_device (device_id, project_id, gate_name, device_secret_hash) VALUES ('DA', 'PA', 'Entry', ?)").bind(
			await sha256Hex(DEVICE_SECRET),
		),
		...policy.map(([s, m]) => env.DB.prepare("INSERT INTO tb_policy (project_id, subject_type, method) VALUES ('PA', ?, ?)").bind(s, m)),
	]);
});

describe("admin auth", () => {
	it("rejects wrong password and unknown admin", async () => {
		expect((await login("admin-a", "wrong-password")).status).toBe(401);
		expect((await login("nobody")).status).toBe(401);
	});

	it("logs in with project code + admin name; names only need to be unique per project", async () => {
		// case / dash / spaces in the code do not matter; the canonical code comes back
		const ok = await login("admin-a", PASSWORD, " prja0001 ");
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ project_code: "PRJA-0001", project_name: "A" });
		// right name + password, wrong project -> same answer as a wrong password
		expect((await login("admin-a", PASSWORD, "PRJB-0001")).body).toEqual({ error: "INVALID_LOGIN" });
		expect((await login("admin-a", PASSWORD, "NOPE-0000")).status).toBe(401);
		for (const bad of ["PRJ-0001", "PRJA-00011", "1234-ABCD", ""]) expect((await login("admin-a", PASSWORD, bad)).status, bad).toBe(400);

		// "admin-a" may exist in project B too
		await env.DB.prepare("INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password) VALUES ('ADM_B2', 'PB', 'admin-a', ?)")
			.bind(await hashPassword(PASSWORD))
			.run();
		const b = await login("admin-a", PASSWORD, "PRJB-0001");
		expect(b.status).toBe(200);
		expect((await call("GET", "/api/v1/admin/houses", b.body.access_token)).body.houses).toHaveLength(0);
	});

	it("rejects missing token and device tokens", async () => {
		expect((await call("GET", "/api/v1/admin/houses")).status).toBe(401);
		const dev = await call("POST", "/api/v1/auth/device/token", undefined, { device_id: "DA", device_secret: DEVICE_SECRET });
		expect((await call("GET", "/api/v1/admin/houses", dev.body.access_token)).status).toBe(401);
	});
});

describe("house lifecycle", () => {
	it("house -> contact -> vehicle -> credential, and the access API follows every change", async () => {
		const t = (await login("admin-a")).body.access_token;

		const house = await call("POST", "/api/v1/admin/houses", t, { house_number: "99/1", house_code: "991" });
		expect(house.status).toBe(201);
		const hid = house.body.house_id;
		const owner = await call("POST", `/api/v1/admin/houses/${hid}/contacts`, t, { full_name: "สมชาย ใจดี", phone_number: "0812345678", role: "OWNER" });
		expect(owner.status).toBe(201);

		const car = await call("POST", `/api/v1/admin/houses/${hid}/vehicles`, t, { license_plate: "ฮฮ 1111" });
		expect(car.body.license_plate).toBe("ฮฮ1111");
		expect((await call("POST", `/api/v1/admin/houses/${hid}/vehicles`, t, { license_plate: "ฮฮ-1111" })).status).toBe(409);
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "YES" });

		// PIN = house_code + 4 หลัก (กดที่ Keypad ทั้ง 7 หลัก), label = ชื่อสั้น
		const pin = await call("POST", `/api/v1/admin/houses/${hid}/credentials`, t, { cred_type: "PIN", value: "8172", label: "pin ส่งของ" });
		expect(pin.body).toMatchObject({ value: "9918172", label: "pin ส่งของ" });
		expect(pin.status).toBe(201);
		expect(await authorize("PIN", "9918172")).toMatchObject({ decision: "YES" });
		expect((await call("POST", `/api/v1/admin/houses/${hid}/credentials`, t, { cred_type: "PIN", value: "908172" })).status).toBe(400);

		// ค้างชำระ -> ANPR ถูกปฏิเสธ
		expect((await call("PATCH", `/api/v1/admin/houses/${house.body.house_id}`, t, { payment_status: "OVERDUE" })).status).toBe(200);
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "NO", reason_code: "RESIDENT_OVERDUE" });
		expect((await call("PATCH", `/api/v1/admin/houses/${house.body.house_id}`, t, { payment_status: "LATE" })).status).toBe(400);

		// รายละเอียดบ้านมีผู้ติดต่อ และไม่มี hash ของ credential
		const detail = await call("GET", `/api/v1/admin/houses/${hid}`, t);
		expect(detail.body.contacts).toMatchObject([{ full_name: "สมชาย ใจดี", role: "OWNER", line_linked: 0 }]);
		expect(detail.body.vehicles).toHaveLength(1);
		expect(detail.body.credentials[0]).toMatchObject({ cred_type: "PIN", id_status: "ACTIVE" });
		// no valid_until -> 24 hours
		const hours = (Date.parse(detail.body.credentials[0].valid_until.replace(" ", "T") + "Z") - Date.now()) / 3_600_000;
		expect(hours).toBeGreaterThan(23.9);
		expect(hours).toBeLessThanOrEqual(24);

		// duration: forever = no expiry (NULL), 7d = 7 days; an explicit valid_until wins
		const addPin = (body: Record<string, unknown>) =>
			call("POST", `/api/v1/admin/houses/${hid}/credentials`, t, { cred_type: "PIN", ...body });
		expect((await addPin({ value: "5551", duration: "forever" })).status).toBe(201);
		expect((await addPin({ value: "5552", duration: "7d" })).status).toBe(201);
		expect((await addPin({ value: "5553", duration: "7d", valid_until: "2030-01-01 00:00:00" })).status).toBe(201);
		expect((await addPin({ value: "5554", duration: "2w" })).status).toBe(400);
		const until = Object.fromEntries(
			(await call("GET", `/api/v1/admin/houses/${hid}`, t)).body.credentials.map((c: any) => [c.credential_id, c.valid_until]),
		);
		const vals = Object.values(until);
		expect(vals).toContain(null);
		expect(vals).toContain("2030-01-01 00:00:00");
		expect(vals.some((v: any) => v && Math.round((Date.parse(v.replace(" ", "T") + "Z") - Date.now()) / 86_400_000) === 7)).toBe(true);
		expect(JSON.stringify(detail.body)).not.toContain("cred_hash");
		expect(JSON.stringify(detail.body)).not.toContain("9918172");
		expect(detail.body.credentials[0]).toMatchObject({ label: "pin ส่งของ", issued_by_type: "ADMIN" });

		// เพิกถอน PIN
		await call("DELETE", `/api/v1/admin/credentials/${pin.body.credential_id}`, t);
		expect(await authorize("PIN", "9918172")).toMatchObject({ decision: "NO", reason_code: "CREDENTIAL_REVOKED" });

		await call("PATCH", `/api/v1/admin/houses/${house.body.house_id}`, t, { payment_status: "NORMAL" });
		// QRCODE: no value -> server generates one; a client value must be 20 chars of the code alphabet
		const qrPost = (value?: string) => call("POST", `/api/v1/admin/houses/${hid}/credentials`, t, { cred_type: "QRCODE", value });
		const qr = await qrPost();
		expect(qr.status).toBe(201);
		// QR = house_code + 20 ตัว
		expect(qr.body.value).toMatch(/^991[A-HJ-NP-Z2-9]{20}$/);
		expect(await authorize("QRCODE", qr.body.value)).toMatchObject({ decision: "YES" });
		const mine = "ABCDEFGHJKLMNPQRSTUV";
		expect((await qrPost(mine)).body.value).toBe(`991${mine}`);
		expect(await authorize("QRCODE", `991${mine}`)).toMatchObject({ decision: "YES" });
		expect(await authorize("QRCODE", mine)).toMatchObject({ decision: "NO" });
		expect((await qrPost(mine)).status).toBe(409);
		expect((await qrPost("MINE")).status).toBe(400);
		expect((await qrPost("ABCDEFGHJKLMNPQRSTU1")).status).toBe(400); // 1 is not in the alphabet

		// ลบผู้ติดต่อ ไม่กระทบสิทธิ์เข้าออกของบ้าน
		expect((await call("DELETE", `/api/v1/admin/contacts/${owner.body.user_id}`, t)).body.is_active).toBe(0);
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "YES" });

		// ไม่มีผู้อยู่อาศัย -> ทุกช่องทางของบ้านใช้ไม่ได้ และเพิ่มใหม่ไม่ได้
		await call("PATCH", `/api/v1/admin/houses/${hid}`, t, { occupancy_status: "VACANT" });
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "NO", reason_code: "HOUSE_VACANT" });
		expect(await authorize("QRCODE", `991${mine}`)).toMatchObject({ decision: "NO", reason_code: "HOUSE_VACANT" });
		expect((await call("POST", `/api/v1/admin/houses/${hid}/vehicles`, t, { license_plate: "ฮฮ 2222" })).body).toMatchObject({ error: "HOUSE_VACANT" });
		expect((await call("PATCH", `/api/v1/admin/houses/${hid}`, t, { occupancy_status: "EMPTY" })).status).toBe(400);
		await call("PATCH", `/api/v1/admin/houses/${hid}`, t, { occupancy_status: "OCCUPIED" });
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "YES" });

		// ปิดบ้าน -> เข้าไม่ได้ทุกวิธี
		await call("PATCH", `/api/v1/admin/houses/${hid}`, t, { is_active: false });
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "NO", reason_code: "USER_INACTIVE" });
	});

	it("registers every Thai plate format and ANPR matches it however it is spaced", async () => {
		const t = (await login("admin-a")).body.access_token;
		const house = await call("POST", "/api/v1/admin/houses", t, { house_number: "88/8" });
		const hid = house.body.house_id;
		// [typed by admin, stored, as the camera may read it]
		const plates = [
			["กข 1234", "กข1234", "กข1234"], // รย. old: 2 letters + 4 digits
			["1กข 1234", "1กข1234", "1 กข 1234"], // รย. current: digit + 2 letters + 4 digits
			["รวย 9999", "รวย9999", "รวย9999"], // special: 3 letters + 4 digits
			["2กค 5678", "2กค5678", "2กค 5678"], // motorcycle: top line + bottom line (province is a separate field)
			["70-1234", "701234", "70 1234"], // truck
			["80-1234", "801234", "801234"], // bus
			["จ 12", "จ12", "จ12"], // 1-letter category, short number
		];
		for (const [typed, stored, read] of plates) {
			const v = await call("POST", `/api/v1/admin/houses/${hid}/vehicles`, t, { license_plate: typed });
			expect(v.status, typed).toBe(201);
			expect(v.body.license_plate).toBe(stored);
			expect(await authorize("ANPR", read), read).toMatchObject({ decision: "YES" });
		}
		for (const bad of ["ABC123", "1234", "กข", "1กข 12345", "123-1234"]) {
			expect((await call("POST", `/api/v1/admin/houses/${hid}/vehicles`, t, { license_plate: bad })).status, bad).toBe(400);
		}
		// Only one car has this plate: a wrong province from the camera's OCR does not lock the resident out
		expect(await authorize("ANPR", "รวย9999", "ภูเก็ต")).toMatchObject({ decision: "YES" });

		// Same plate, different provinces = different cars; province (with กทม aliases) tells them apart
		const add = (province?: string) =>
			call("POST", `/api/v1/admin/houses/${hid}/vehicles`, t, { license_plate: "9กก 9999", province });
		expect((await add("กทม")).status).toBe(201);
		expect((await add("เชียงใหม่")).status).toBe(201);
		expect((await add("กรุงเทพมหานคร")).status).toBe(409);
		expect((await add()).status).toBe(409);
		expect(await authorize("ANPR", "9กก9999")).toMatchObject({ decision: "NO", reason_code: "PLATE_AMBIGUOUS" });
		expect(await authorize("ANPR", "9กก9999", "เชียงใหม่")).toMatchObject({ decision: "YES" });
		expect(await authorize("ANPR", "9กก9999", "กรุงเทพฯ")).toMatchObject({ decision: "YES" });
		expect(await authorize("ANPR", "9กก9999", "ภูเก็ต")).toMatchObject({ decision: "NO", reason_code: "PLATE_AMBIGUOUS" });
	});

	it("validates contact fields and unknown house", async () => {
		const t = (await login("admin-a")).body.access_token;
		const hid = (await call("POST", "/api/v1/admin/houses", t, { house_number: "77/7" })).body.house_id;
		expect((await call("POST", `/api/v1/admin/houses/${hid}/contacts`, t, {})).body).toMatchObject({ field: "full_name" });
		expect((await call("POST", `/api/v1/admin/houses/${hid}/contacts`, t, { full_name: "x", role: "BOSS" })).status).toBe(400);
		expect((await call("POST", "/api/v1/admin/houses/nope/contacts", t, { full_name: "x" })).status).toBe(404);
		expect((await call("POST", "/api/v1/admin/houses/nope/vehicles", t, { license_plate: "กข 1" })).status).toBe(404);

		// ผู้ติดต่อหลายคน เจ้าบ้านขึ้นก่อน; แก้บทบาทได้
		const tenant = (await call("POST", `/api/v1/admin/houses/${hid}/contacts`, t, { full_name: "ผู้เช่า", role: "TENANT" })).body.user_id;
		await call("POST", `/api/v1/admin/houses/${hid}/contacts`, t, { full_name: "เจ้าบ้าน", role: "OWNER" });
		const listed = (await call("GET", "/api/v1/admin/houses", t)).body.houses.find((h: any) => h.house_id === hid);
		expect(listed.contacts.map((c: any) => c.role)).toEqual(["OWNER", "TENANT"]);
		expect((await call("PATCH", `/api/v1/admin/contacts/${tenant}`, t, { role: "RESIDENT" })).status).toBe(200);
	});
});

describe("root", () => {
	it("root (PLAY-0013) manages projects and their admins; admins cannot", async () => {
		await env.DB.prepare("INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password, admin_level, ref) VALUES ('ROOT1', 'PRJ-PLAY', 'root', ?, 'ROOT', 'PLAY-0013-R01')")
			.bind(await hashPassword(PASSWORD))
			.run();
		const r = await login("root", PASSWORD, "PLAY-0013");
		expect(r.body).toMatchObject({ admin_level: "ROOT", project_code: "PLAY-0013" });
		const root = r.body.access_token;
		const a = (await login("admin-a")).body;
		expect(a.admin_level).toBe("ADMIN");

		expect((await call("GET", "/api/v1/admin/projects", a.access_token)).status).toBe(403);
		expect((await call("POST", "/api/v1/admin/admins", a.access_token, { project_code: "PRJA-0001", admin_name: "x", password: PASSWORD })).status).toBe(403);

		const p = await call("POST", "/api/v1/admin/projects", root, { project_code: "sntw bk01", project_name: "แสนสิริ บางนา" });
		expect(p.body.project_code).toBe("SNTW-BK01");
		expect((await call("POST", "/api/v1/admin/projects", root, { project_code: "SNTW-BK01", project_name: "dup" })).status).toBe(409);
		const ad = await call("POST", "/api/v1/admin/admins", root, { project_code: "SNTW-BK01", admin_name: "admin", password: PASSWORD });
		expect(ad.body.ref).toBe("SNTW-BK01-A01");
		expect((await call("POST", "/api/v1/admin/admins", root, { project_code: "SNTW-BK01", admin_name: "admin", password: PASSWORD })).status).toBe(409);
		expect((await call("POST", "/api/v1/admin/admins", root, { project_code: "SNTW-BK01", admin_name: "y", password: "short" })).status).toBe(400);
		// an admin created by root must set their own password first
		const first = (await login("admin", PASSWORD, "SNTW-BK01")).body;
		expect(first.must_change_password).toBe(true);
		expect((await call("GET", "/api/v1/admin/houses", first.access_token)).body.error).toBe("PASSWORD_CHANGE_REQUIRED");
		const change = (body: object) => call("POST", "/api/v1/admin/me/password", first.access_token, body);
		expect((await change({ current_password: "wrong-password!", new_password: "brand-new-password" })).body.error).toBe("WRONG_PASSWORD");
		expect((await change({ current_password: PASSWORD, new_password: "short" })).body.field).toBe("new_password");
		expect((await change({ current_password: PASSWORD, new_password: PASSWORD })).body.field).toBe("new_password");
		expect((await change({ current_password: PASSWORD, new_password: "brand-new-password" })).status).toBe(200);
		expect((await call("GET", "/api/v1/admin/houses", first.access_token)).status).toBe(200);
		expect((await login("admin", "brand-new-password", "SNTW-BK01")).body.must_change_password).toBe(false);

		// forgot password: root issues a one-time random password, the admin must change it again
		const reset = await call("POST", `/api/v1/admin/admins/${ad.body.admin_id}/reset-password`, root);
		expect(reset.body.password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
		expect((await login("admin", "brand-new-password", "SNTW-BK01")).status).toBe(401);
		expect((await login("admin", reset.body.password, "SNTW-BK01")).body.must_change_password).toBe(true);
		expect((await call("POST", `/api/v1/admin/admins/${ad.body.admin_id}/reset-password`, a.access_token)).status).toBe(403);
		expect((await call("POST", "/api/v1/admin/admins/ROOT1/reset-password", root)).status).toBe(404);
		const audit = await env.DB.prepare("SELECT detail FROM tb_audit_log WHERE action LIKE '%me/password'").all<{ detail: string }>();
		expect(JSON.stringify(audit.results)).not.toContain("brand-new-password");

		// root works inside any project with X-Project-Code; an admin's header is ignored
		await call("POST", "/api/v1/admin/houses", root, { house_number: "1/1" }, { "X-Project-Code": "SNTW-BK01" });
		expect((await call("GET", "/api/v1/admin/houses", root, undefined, { "X-Project-Code": "SNTW-BK01" })).body.houses).toHaveLength(1);
		expect((await call("GET", "/api/v1/admin/houses", root, undefined, { "X-Project-Code": "NOPE-0000" })).status).toBe(404);
		const bHouses = (await call("GET", "/api/v1/admin/houses", (await login("admin-b")).body.access_token, undefined, { "X-Project-Code": "SNTW-BK01" })).body.houses;
		expect(bHouses).toHaveLength(0);
		expect((await call("GET", "/api/v1/admin/projects", root)).body.projects.map((x: any) => x.project_code)).toContain("SNTW-BK01");
	});
});

describe("project isolation", () => {
	it("admin of project B cannot see or change project A data", async () => {
		const ta = (await login("admin-a")).body.access_token;
		const tb = (await login("admin-b")).body.access_token;
		const house = await call("POST", "/api/v1/admin/houses", ta, { house_number: "1/1" });
		const hid = house.body.house_id;
		const user = await call("POST", `/api/v1/admin/houses/${hid}/contacts`, ta, { full_name: "A only" });

		expect((await call("GET", `/api/v1/admin/houses/${hid}`, tb)).status).toBe(404);
		expect((await call("PATCH", `/api/v1/admin/houses/${hid}`, tb, { payment_status: "OVERDUE" })).status).toBe(404);
		expect((await call("PATCH", `/api/v1/admin/contacts/${user.body.user_id}`, tb, { full_name: "x" })).status).toBe(404);
		expect((await call("DELETE", `/api/v1/admin/contacts/${user.body.user_id}`, tb)).status).toBe(404);
		expect((await call("POST", `/api/v1/admin/houses/${hid}/contacts`, tb, { full_name: "x" })).status).toBe(404);
		expect((await call("POST", `/api/v1/admin/houses/${hid}/credentials`, tb, { cred_type: "PIN", value: "4321" })).status).toBe(404);
		expect((await call("GET", "/api/v1/admin/houses", tb)).body.houses).toHaveLength(0);
	});
});
