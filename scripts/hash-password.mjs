// สร้าง hash สำหรับ tb_admin.admin_password (รูปแบบเดียวกับ verifyPassword ใน src/crypto.ts)
// ใช้: node scripts/hash-password.mjs   แล้วพิมพ์รหัสผ่าน (อ่านจาก stdin ไม่รับทาง argument กันหลุดใน shell history)
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const ITERATIONS = 100_000;
const rl = createInterface({ input: process.stdin, output: process.stderr });
process.stderr.write("Password: ");
// for await อ่านบรรทัดสุดท้ายได้แม้ไม่มี newline (เช่น pipe จากไฟล์) ซึ่ง rl.question ทำไม่ได้
let password = "";
for await (const line of rl) {
	password = line;
	break;
}
rl.close();
if (password.length < 12) {
	console.error("password ต้องยาวอย่างน้อย 12 ตัวอักษร");
	process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
console.log(`pbkdf2_sha256$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`);
