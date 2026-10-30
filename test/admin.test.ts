import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, sha256Hex } from "../src/crypto";

const PASSWORD = "correct-horse-battery";
const DEVICE_SECRET = "admin-test-device-secret";

const call = async (method: string, path: string, token?: string, body?: unknown) => {
	const res = await exports.default.fetch(`https://aaa.test${path}`, {
		method,
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, any> };
};

async function login(name: string, password = PASSWORD) {
	return call("POST", "/api/v1/admin/login", undefined, { admin_name: name, password });
}

async function authorize(method: string, value: string) {
	const tok = await call("POST", "/api/v1/auth/device/token", undefined, { device_id: "DA", device_secret: DEVICE_SECRET });
	return (await call("POST", "/api/v1/access/authorize", tok.body.access_token, { event_id: crypto.randomUUID(), method, value })).body;
}

beforeAll(async () => {
	const hash = await hashPassword(PASSWORD);
	const policy = [
		["RESIDENT", "ANPR"], ["RESIDENT", "RFID"], ["RESIDENT", "PIN"],
		["RESIDENT_OVERDUE", "RFID"], ["RESIDENT_OVERDUE", "PIN"],
	];
	await env.DB.batch([
		env.DB.prepare("INSERT INTO tb_project (project_id, project_name) VALUES ('PA', 'A'), ('PB', 'B')"),
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

	it("rejects missing token and device tokens", async () => {
		expect((await call("GET", "/api/v1/admin/residents")).status).toBe(401);
		const dev = await call("POST", "/api/v1/auth/device/token", undefined, { device_id: "DA", device_secret: DEVICE_SECRET });
		expect((await call("GET", "/api/v1/admin/residents", dev.body.access_token)).status).toBe(401);
	});
});

describe("resident lifecycle", () => {
	it("house -> resident -> vehicle -> credential, and the access API follows every change", async () => {
		const t = (await login("admin-a")).body.access_token;

		const house = await call("POST", "/api/v1/admin/houses", t, { house_number: "99/1" });
		expect(house.status).toBe(201);
		const user = await call("POST", "/api/v1/admin/residents", t, { house_id: house.body.house_id, full_name: "สมชาย ใจดี" });
		expect(user.status).toBe(201);
		const uid = user.body.user_id;

		const car = await call("POST", `/api/v1/admin/residents/${uid}/vehicles`, t, { license_plate: "ฮฮ 1111" });
		expect(car.body.license_plate).toBe("ฮฮ1111");
		expect((await call("POST", `/api/v1/admin/residents/${uid}/vehicles`, t, { license_plate: "ฮฮ-1111" })).status).toBe(409);
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "YES" });

		const pin = await call("POST", `/api/v1/admin/residents/${uid}/credentials`, t, { cred_type: "PIN", value: "908172" });
		expect(pin.status).toBe(201);
		expect(await authorize("PIN", "908172")).toMatchObject({ decision: "YES" });
		expect((await call("POST", `/api/v1/admin/residents/${uid}/credentials`, t, { cred_type: "PIN", value: "12" })).status).toBe(400);

		// ค้างชำระ -> ANPR ถูกปฏิเสธ
		expect((await call("PATCH", `/api/v1/admin/houses/${house.body.house_id}`, t, { payment_status: "OVERDUE" })).status).toBe(200);
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "NO", reason_code: "RESIDENT_OVERDUE" });
		expect((await call("PATCH", `/api/v1/admin/houses/${house.body.house_id}`, t, { payment_status: "LATE" })).status).toBe(400);

		// รายละเอียดลูกบ้านไม่มี hash ของ credential
		const detail = await call("GET", `/api/v1/admin/residents/${uid}`, t);
		expect(detail.body.vehicles).toHaveLength(1);
		expect(detail.body.credentials[0]).toMatchObject({ cred_type: "PIN", id_status: "ACTIVE" });
		expect(JSON.stringify(detail.body)).not.toContain("cred_hash");
		expect(JSON.stringify(detail.body)).not.toContain("908172");

		// เพิกถอน PIN
		await call("DELETE", `/api/v1/admin/credentials/${pin.body.credential_id}`, t);
		expect(await authorize("PIN", "908172")).toMatchObject({ decision: "NO", reason_code: "CREDENTIAL_REVOKED" });

		// ปิดลูกบ้าน -> เข้าไม่ได้ทุกวิธี
		await call("PATCH", `/api/v1/admin/houses/${house.body.house_id}`, t, { payment_status: "NORMAL" });
		expect((await call("DELETE", `/api/v1/admin/residents/${uid}`, t)).body.is_active).toBe(0);
		expect(await authorize("ANPR", "ฮฮ1111")).toMatchObject({ decision: "NO", reason_code: "UNKNOWN_PLATE" });
	});

	it("validates required fields and unknown house", async () => {
		const t = (await login("admin-a")).body.access_token;
		expect((await call("POST", "/api/v1/admin/residents", t, { full_name: "x" })).body).toMatchObject({ field: "house_id" });
		expect((await call("POST", "/api/v1/admin/residents", t, { house_id: "nope", full_name: "x" })).status).toBe(404);
	});
});

describe("project isolation", () => {
	it("admin of project B cannot see or change project A data", async () => {
		const ta = (await login("admin-a")).body.access_token;
		const tb = (await login("admin-b")).body.access_token;
		const house = await call("POST", "/api/v1/admin/houses", ta, { house_number: "1/1" });
		const user = await call("POST", "/api/v1/admin/residents", ta, { house_id: house.body.house_id, full_name: "A only" });

		expect((await call("GET", `/api/v1/admin/residents/${user.body.user_id}`, tb)).status).toBe(404);
		expect((await call("PATCH", `/api/v1/admin/houses/${house.body.house_id}`, tb, { payment_status: "OVERDUE" })).status).toBe(404);
		expect((await call("DELETE", `/api/v1/admin/residents/${user.body.user_id}`, tb)).status).toBe(404);
		expect((await call("POST", "/api/v1/admin/residents", tb, { house_id: house.body.house_id, full_name: "x" })).status).toBe(404);
		expect((await call("GET", "/api/v1/admin/residents", tb)).body.residents).toHaveLength(0);
	});
});
