import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { credentialHash, type Method } from "../src/authorize";
import { sha256Hex } from "../src/crypto";

const P = "PRJ1";
const DEVICE_SECRET = "s3cret-device-key";
const PIN = "739104";

const post = (path: string, body: unknown, token?: string) =>
	exports.default.fetch(`https://aaa.test${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});

async function seed() {
	const h = (m: Method, v: string) => credentialHash(env.CRED_PEPPER, P, m, v);
	const stmts = [
		`INSERT OR IGNORE INTO tb_project (project_id, project_name) VALUES ('${P}', 'Test Village')`,
		`INSERT OR IGNORE INTO tb_house (house_id, project_id, house_number) VALUES ('H1', '${P}', '1/1')`,
		`INSERT OR IGNORE INTO tb_house (house_id, project_id, house_number, payment_status) VALUES ('H2', '${P}', '1/2', 'OVERDUE')`,
		`INSERT OR IGNORE INTO tb_user (user_id, project_id, house_id, full_name) VALUES ('U1', '${P}', 'H1', 'Normal Resident')`,
		`INSERT OR IGNORE INTO tb_user (user_id, project_id, house_id, full_name) VALUES ('U2', '${P}', 'H2', 'Overdue Resident')`,
		`INSERT OR IGNORE INTO tb_house (house_id, project_id, house_number, payment_status) VALUES ('H3', '${P}', '1/3', 'OVERDUE_SEVERE')`,
		`INSERT OR IGNORE INTO tb_user (user_id, project_id, house_id, full_name) VALUES ('U3', '${P}', 'H3', 'Severe Overdue Resident')`,
		`INSERT OR IGNORE INTO tb_vehicle (vehicle_id, project_id, user_id, license_plate) VALUES ('V3', '${P}', 'U3', 'จจ7777')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, user_id, cred_type, cred_hash) VALUES ('C_RFID3', '${P}', 'U3', 'RFID', '${await h("RFID", "CARD-U3")}')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, user_id, cred_type, cred_hash) VALUES ('C_PIN3', '${P}', 'U3', 'PIN', '${await h("PIN", "662288")}')`,
		`INSERT OR IGNORE INTO tb_vehicle (vehicle_id, project_id, user_id, license_plate) VALUES ('V1', '${P}', 'U1', 'กก9999')`,
		`INSERT OR IGNORE INTO tb_vehicle (vehicle_id, project_id, user_id, license_plate) VALUES ('V2', '${P}', 'U2', 'ขข1234')`,
		`INSERT OR IGNORE INTO tb_blacklist (blacklist_id, project_id, license_plate) VALUES ('B1', '${P}', 'ดด6666')`,
		`INSERT OR IGNORE INTO tb_visitor (visitor_id, project_id, house_id, license_plate, valid_from, valid_until)
		   VALUES ('VS1', '${P}', 'H1', 'คค5555', datetime('now', '-1 hour'), datetime('now', '+1 hour'))`,
		`INSERT OR IGNORE INTO tb_visitor (visitor_id, project_id, house_id, valid_from, valid_until)
		   VALUES ('VS2', '${P}', 'H1', datetime('now', '-2 day'), datetime('now', '-1 day'))`,
		`INSERT OR IGNORE INTO tb_device (device_id, project_id, gate_name, device_secret_hash)
		   VALUES ('D1', '${P}', 'Entry', '${await sha256Hex(DEVICE_SECRET)}')`,
		`INSERT OR IGNORE INTO tb_device (device_id, project_id, gate_name, device_secret_hash, is_active)
		   VALUES ('D_REVOKED', '${P}', 'Entry', '${await sha256Hex(DEVICE_SECRET)}', 1)`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, user_id, cred_type, cred_hash) VALUES ('C_RFID2', '${P}', 'U2', 'RFID', '${await h("RFID", "CARD-U2")}')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, user_id, cred_type, cred_hash) VALUES ('C_PIN2', '${P}', 'U2', 'PIN', '${await h("PIN", "551177")}')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, user_id, cred_type, cred_hash) VALUES ('C_QR2', '${P}', 'U2', 'QRCODE', '${await h("QRCODE", "qr-u2")}')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, user_id, cred_type, cred_hash) VALUES ('C_PIN1', '${P}', 'U1', 'PIN', '${await h("PIN", PIN)}')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, visitor_id, cred_type, cred_hash, max_uses) VALUES ('C_QR_ONCE', '${P}', 'VS1', 'QRCODE', '${await h("QRCODE", "qr-once")}', 1)`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, visitor_id, cred_type, cred_hash) VALUES ('C_QR_OLD', '${P}', 'VS2', 'QRCODE', '${await h("QRCODE", "qr-old")}')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, visitor_id, cred_type, cred_hash, id_status) VALUES ('C_QR_REV', '${P}', 'VS1', 'QRCODE', '${await h("QRCODE", "qr-revoked")}', 'REVOKED')`,
		`INSERT OR IGNORE INTO tb_credential (credential_id, project_id, visitor_id, cred_type, cred_hash, valid_until) VALUES ('C_QR_EXP', '${P}', 'VS1', 'QRCODE', '${await h("QRCODE", "qr-expired")}', datetime('now', '-1 minute'))`,
	];
	const policy: [string, Method][] = [
		["RESIDENT", "ANPR"], ["RESIDENT", "RFID"], ["RESIDENT", "QRCODE"], ["RESIDENT", "PIN"],
		["RESIDENT_OVERDUE", "RFID"], ["RESIDENT_OVERDUE", "PIN"],
		["RESIDENT_OVERDUE_SEVERE", "PIN"],
		["VISITOR", "QRCODE"], ["VISITOR", "ANPR"],
	];
	for (const [s, m] of policy) stmts.push(`INSERT OR IGNORE INTO tb_policy (project_id, subject_type, method) VALUES ('${P}', '${s}', '${m}')`);
	await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
}

async function token(deviceId = "D1") {
	const res = await post("/api/v1/auth/device/token", { device_id: deviceId, device_secret: DEVICE_SECRET });
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

let n = 0;
async function ask(method: Method, value: string, eventId = `evt-${++n}-${crypto.randomUUID()}`) {
	const res = await post("/api/v1/access/authorize", { event_id: eventId, method, value }, await token());
	return { status: res.status, body: (await res.json()) as { decision: string; reason_code: string; allowed_methods: string[] } };
}

beforeEach(seed);

describe("device token", () => {
	it("rejects wrong secret", async () => {
		const res = await post("/api/v1/auth/device/token", { device_id: "D1", device_secret: "nope" });
		expect(res.status).toBe(401);
	});

	it("rejects authorize without or with forged token", async () => {
		expect((await post("/api/v1/access/authorize", { event_id: "e", method: "ANPR", value: "x" })).status).toBe(401);
		expect((await post("/api/v1/access/authorize", { event_id: "e", method: "ANPR", value: "x" }, "a.b.c")).status).toBe(401);
	});

	it("revoking a device takes effect before the token expires", async () => {
		const t = await token("D_REVOKED");
		await env.DB.prepare("UPDATE tb_device SET is_active = 0 WHERE device_id = 'D_REVOKED'").run();
		const res = await post("/api/v1/access/authorize", { event_id: "e-rev", method: "ANPR", value: "กก9999" }, t);
		expect(res.status).toBe(401);
	});
});

describe("ANPR", () => {
	it("allows an active resident plate, ignoring spaces", async () => {
		const { body } = await ask("ANPR", "กก 9999");
		expect(body).toMatchObject({ decision: "YES", reason_code: "RESIDENT_ACTIVE" });
	});

	it("rejects unknown and blacklisted plates", async () => {
		expect((await ask("ANPR", "ZZ0000")).body).toMatchObject({ decision: "NO", reason_code: "UNKNOWN_PLATE" });
		expect((await ask("ANPR", "ดด6666")).body).toMatchObject({ decision: "NO", reason_code: "BLACKLISTED" });
	});

	it("overdue resident: ANPR denied but card and keypad still work", async () => {
		const { body } = await ask("ANPR", "ขข1234");
		expect(body).toMatchObject({ decision: "NO", reason_code: "RESIDENT_OVERDUE", allowed_methods: ["RFID", "PIN"] });
		expect((await ask("RFID", "CARD-U2")).body).toMatchObject({ decision: "YES", reason_code: "RESIDENT_OVERDUE_ALLOWED" });
		expect((await ask("PIN", "551177")).body).toMatchObject({ decision: "YES", reason_code: "RESIDENT_OVERDUE_ALLOWED" });
		expect((await ask("QRCODE", "qr-u2")).body).toMatchObject({ decision: "NO", reason_code: "RESIDENT_OVERDUE" });
	});

	it("severely overdue resident: only keypad works", async () => {
		const denied = { decision: "NO", reason_code: "RESIDENT_OVERDUE_SEVERE", allowed_methods: ["PIN"] };
		expect((await ask("ANPR", "จจ7777")).body).toMatchObject(denied);
		expect((await ask("RFID", "CARD-U3")).body).toMatchObject(denied);
		expect((await ask("PIN", "662288")).body).toMatchObject({ decision: "YES", reason_code: "RESIDENT_OVERDUE_ALLOWED" });
	});

	it("allows a visitor plate inside its time window", async () => {
		expect((await ask("ANPR", "คค5555")).body).toMatchObject({ decision: "YES", reason_code: "VISITOR_VALID" });
	});
});

describe("credentials", () => {
	it("one-time visitor QR works once, replay of same event_id returns same answer", async () => {
		const first = await ask("QRCODE", "qr-once", "evt-qr-once");
		expect(first.body).toMatchObject({ decision: "YES", reason_code: "VISITOR_VALID" });
		expect((await ask("QRCODE", "qr-once", "evt-qr-once")).body).toMatchObject({ decision: "YES" });
		expect((await ask("QRCODE", "qr-once")).body).toMatchObject({ decision: "NO", reason_code: "CREDENTIAL_USED_UP" });
	});

	it("rejects revoked, expired, outside-window and unknown QR", async () => {
		expect((await ask("QRCODE", "qr-revoked")).body.reason_code).toBe("CREDENTIAL_REVOKED");
		expect((await ask("QRCODE", "qr-expired")).body.reason_code).toBe("CREDENTIAL_EXPIRED");
		expect((await ask("QRCODE", "qr-old")).body.reason_code).toBe("VISITOR_NOT_VALID");
		expect((await ask("QRCODE", "who-knows")).body.reason_code).toBe("UNKNOWN_CREDENTIAL");
	});

	it("PIN works and is never written to the log or DB in plaintext", async () => {
		expect((await ask("PIN", PIN, "evt-pin")).body).toMatchObject({ decision: "YES" });
		const log = await env.DB.prepare("SELECT * FROM tb_access_log WHERE log_id = 'evt-pin'").first();
		expect(log).toMatchObject({ method: "PIN", decision: "YES", credential_ref: "C_PIN1", license_plate: null });
		expect(JSON.stringify(log)).not.toContain(PIN);
		const cred = await env.DB.prepare("SELECT cred_hash FROM tb_credential WHERE credential_id = 'C_PIN1'").first<string>("cred_hash");
		expect(cred).not.toContain(PIN);
	});
});

describe("request validation", () => {
	it("rejects unknown method", async () => {
		const res = await post("/api/v1/access/authorize", { event_id: "e1", method: "FACE", value: "x" }, await token());
		expect(res.status).toBe(400);
	});
});
