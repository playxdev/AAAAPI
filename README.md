# AAAAPI — Axis Auto Access API (Cloudflare Workers)

Backend ตรวจสิทธิ์เข้า-ออก + Admin API + Owner API (LINE LIFF) เขียนด้วย TypeScript บน Cloudflare Workers + D1
ภาพรวมระบบ / tech stack: repo **AAACLOUDF** · Schema: repo **AAASQL**

Production: `https://aaa-api.cookievirus.workers.dev`

## โครงสร้าง

```
src/index.ts                 routing, CORS, device token, authorize endpoint, access log
src/authorize.ts             ตัดสินสิทธิ์ (ANPR / credential / Guest Code / policy)
src/admin.ts                 Admin API: login, บ้าน, ลูกบ้าน, รถ, บัตร/PIN, Visitor, รหัสผูก LINE
src/owner.ts                 Owner API (LINE LIFF): login, ผูกบัญชี, ออก / เพิกถอน Guest Code
src/guest.ts                 ออก Guest Code / Visitor (admin + owner ใช้ร่วมกัน)
src/audit.ts                 tb_audit_log
src/crypto.ts                SHA-256, HMAC, JWT, PBKDF2 (WebCrypto)
src/http.ts                  helper ของ request / response / validation
scripts/hash-password.mjs    สร้าง hash รหัสผ่าน admin
test/                        integration tests (workerd + D1 local)
```

## Setup

```sh
npm install
npx wrangler login
npx wrangler secret put JWT_SECRET    # key เซ็น device JWT
npx wrangler secret put CRED_PEPPER   # key HMAC ของ RFID / QR / PIN (ห้ามเปลี่ยนหลังลงทะเบียน credential แล้ว)
# แก้ vars ใน wrangler.jsonc: ALLOWED_ORIGINS (origin ของ Pages + LIFF), LINE_CHANNEL_ID (LINE Login channel ของ LIFF)
CLOUDFLARE_ACCOUNT_ID=30ec5dca725dd7acef6a6ef89342e403 npx wrangler d1 migrations apply db1-aaa --remote
npm run deploy
```

wrangler 4.156.0: คำสั่ง `d1 migrations ...` ไม่อ่าน `account_id` จาก `wrangler.jsonc` (login นี้เห็น 2 บัญชี)
ต้องใส่ `CLOUDFLARE_ACCOUNT_ID` เอง คำสั่งอื่น (`deploy`, `d1 execute`, `d1 info`) ใช้ค่าใน `wrangler.jsonc` ได้

Schema / migrations / seed อยู่ใน repo [AAASQL](https://github.com/playxdev/AAASQL) (`migrations_dir` = `../AAASQL/migrations`)
ต้อง clone AAAAPI กับ AAASQL ไว้ใน folder เดียวกัน ทั้ง `wrangler` และ `npm test` อ่าน migration จากที่นั่น

Production: `https://aaa-api.cookievirus.workers.dev` (บัญชี Cookievirus, D1 `db1-aaa` region APAC)
Secrets `JWT_SECRET` / `CRED_PEPPER` ตั้งแล้วด้วยค่าสุ่ม ไม่มีสำเนาที่อื่น ห้ามเปลี่ยน `CRED_PEPPER` (credential ทั้งหมดจะใช้ไม่ได้)

สถานะ production (2026-10-30):
- Migration `0001` + `0002` apply แล้ว, policy seed แล้ว
- โครงการ `PRJ-001` (หมู่บ้านทดสอบ) + admin `admin` (`ADM-001`)
- ยังว่าง: `ALLOWED_ORIGINS`, `LINE_CHANNEL_ID` (Admin WebApp / LIFF ยังเรียก API จาก browser ไม่ได้)
- ยังไม่มี rate limit ที่ `/admin/login`, `/owner/*`, `/auth/device/token` (`workers.dev` ตั้ง WAF ไม่ได้
  ต้องใช้ Workers Rate Limiting binding หรือย้ายไปโดเมนของตัวเอง)

### สร้าง Admin คนแรก

Admin แต่ละคนผูกกับ 1 โครงการ (`tb_admin.project_id`) และเห็นเฉพาะข้อมูลของโครงการนั้น

```sh
node scripts/hash-password.mjs        # พิมพ์รหัสผ่าน (อย่างน้อย 12 ตัวอักษร) ได้ hash pbkdf2_sha256$...
npx wrangler d1 execute db1-aaa --remote --command \
  "INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password) VALUES ('ADM-001', '<project_id>', '<admin_name>', '<hash>')"
```

## Dev / Test

```sh
npm run dev     # local, ใช้ secrets จาก .dev.vars
npm test
```

## API

### `POST /api/v1/auth/device/token`

```json
{ "device_id": "D1", "device_secret": "..." }
```
→ `{ "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 900 }`

### `POST /api/v1/access/authorize`

Header `Authorization: Bearer <JWT>`

```json
{ "event_id": "evt-unique-id", "method": "ANPR", "value": "กก9999" }
```
→ `{ "event_id": "...", "decision": "YES|NO|ERROR", "reason_code": "...", "allowed_methods": ["RFID"], "policy_version": 1 }`

- `method`: `ANPR` / `RFID` / `QRCODE` / `PIN`
- `event_id` ซ้ำ → ได้คำตอบเดิม ไม่ตัดสินซ้ำ
- `ERROR` ตอบ HTTP 500 และห้ามตีความเป็น `YES`

`reason_code`: `RESIDENT_ACTIVE`, `RESIDENT_OVERDUE_ALLOWED`, `VISITOR_VALID`, `RESIDENT_OVERDUE`, `RESIDENT_OVERDUE_SEVERE`,
`METHOD_NOT_ALLOWED`, `BLACKLISTED`, `UNKNOWN_PLATE`, `UNKNOWN_CREDENTIAL`, `CREDENTIAL_REVOKED`,
`CREDENTIAL_NOT_YET_VALID`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_USED_UP`, `USER_INACTIVE`, `VISITOR_NOT_VALID`,
`TOO_MANY_ATTEMPTS`, `INTERNAL_ERROR`, `LOG_FAILED`

`TOO_MANY_ATTEMPTS`: อุปกรณ์เดียวกันส่ง PIN / QR ที่ไม่รู้จักครบ 10 ครั้งใน 5 นาที จะปฏิเสธ PIN / QR ของอุปกรณ์นั้นจนพ้นช่วงเวลา
(กันสุ่ม Guest Code) ANPR และ RFID ยังใช้ได้

## Admin API

ทุก endpoint (ยกเว้น login) ต้องส่ง Header `Authorization: Bearer <admin JWT>`
`project_id` มาจาก token เสมอ admin โครงการอื่นจะได้ `404` เหมือนไม่มีข้อมูล

| Method | Endpoint | Body / หมายเหตุ |
|---|---|---|
| `POST` | `/api/v1/admin/login` | `{ admin_name, password }` → `{ access_token, expires_in: 3600 }` |
| `GET` | `/api/v1/admin/houses` | รายการบ้าน |
| `POST` | `/api/v1/admin/houses` | `{ house_number, house_code?, zone_or_soi? }` |
| `PATCH` | `/api/v1/admin/houses/:id` | `{ house_number?, house_code?, zone_or_soi?, payment_status?, is_active? }` |
| `GET` | `/api/v1/admin/residents` | `?house_id=` กรองตามบ้านได้ |
| `POST` | `/api/v1/admin/residents` | `{ house_id, full_name, phone_number?, line_id? }` |
| `GET` | `/api/v1/admin/residents/:id` | ลูกบ้าน + รถ + credential (ไม่มี hash / ค่าจริง) |
| `PATCH` | `/api/v1/admin/residents/:id` | `{ house_id?, full_name?, phone_number?, line_id?, is_active? }` |
| `DELETE` | `/api/v1/admin/residents/:id` | ปิดใช้งาน (soft delete) เข้าไม่ได้ทุกวิธี |
| `POST` | `/api/v1/admin/residents/:id/vehicles` | `{ license_plate, province?, brand?, color? }` ทะเบียนซ้ำในโครงการ → `409` |
| `DELETE` | `/api/v1/admin/vehicles/:id` | ปิดใช้งานรถ |
| `POST` | `/api/v1/admin/residents/:id/credentials` | `{ cred_type: RFID\|QRCODE\|PIN, value, valid_from?, valid_until? }` PIN = ตัวเลข 4–8 หลัก, ซ้ำ → `409` |
| `DELETE` | `/api/v1/admin/credentials/:id` | เพิกถอน (`REVOKED`) |
| `POST` | `/api/v1/admin/residents/:id/link-code` | ออกรหัสผูก LINE 8 ตัว ใช้ครั้งเดียว อายุ 24 ชม. → `{ link_code }` |
| `GET` | `/api/v1/admin/visitors` | `?house_id=` / `?valid=1` (เฉพาะที่ยังไม่หมดอายุ) |
| `POST` | `/api/v1/admin/visitors` | `{ duration, house_id?, full_name?, phone_number?, license_plate?, purpose?, issue_code? }` ไม่ส่ง `house_id` = งานส่วนกลาง |
| `DELETE` | `/api/v1/admin/visitors/:id` | เพิกถอน visitor + Guest Code |

- `payment_status`: `NORMAL` / `OVERDUE` / `OVERDUE_SEVERE`
- `house_code`: ตัวเลข 1–6 หลัก ไม่ขึ้นต้นด้วย 0 ไม่ซ้ำในโครงการ ต้องมีก่อนบ้านนั้นจะออก Guest Code ได้
- Error: `{ "error": "BAD_REQUEST", "field": "<ชื่อ field>" }`, `NOT_FOUND`, `PLATE_EXISTS`, `CREDENTIAL_EXISTS`,
  `HOUSE_CODE_MISSING`, `GUEST_CODE_UNAVAILABLE`, `CONFLICT`, `UNAUTHORIZED`
- ค่าของ RFID / QR / PIN ถูก hash ทันที อ่านค่าจริงกลับจาก API ไม่ได้

## Owner API (LINE LIFF)

สำหรับลูกบ้าน / เจ้าของบ้าน เรียกจาก LIFF app ส่ง LIFF ID Token (`liff.getIDToken()`) มาแลก JWT

ผูกบัญชีครั้งแรก:
1. Admin เรียก `POST /api/v1/admin/residents/:id/link-code` แล้วส่งรหัสให้ลูกบ้าน
2. ลูกบ้านเปิด LIFF กรอกรหัส → LIFF เรียก `POST /api/v1/owner/link`
3. ครั้งต่อไป LIFF เรียก `POST /api/v1/owner/login` ได้เลย

| Method | Endpoint | Body / หมายเหตุ |
|---|---|---|
| `POST` | `/api/v1/owner/link` | `{ id_token, link_code }` → JWT; รหัสผิด / หมดอายุ → `400 INVALID_LINK_CODE`, LINE ผูกกับคนอื่นแล้ว → `409` |
| `POST` | `/api/v1/owner/login` | `{ id_token }` → JWT; ยังไม่ผูก → `403 NOT_LINKED` |
| `GET` | `/api/v1/owner/me` | ข้อมูลลูกบ้าน + บ้าน + `house_code` |
| `GET` | `/api/v1/owner/visitors` | visitor ของบ้านตัวเองเท่านั้น (`?valid=1`) |
| `POST` | `/api/v1/owner/visitors` | `{ duration, full_name?, phone_number?, license_plate?, purpose? }` → `{ visitor_id, code, valid_until }` |
| `DELETE` | `/api/v1/owner/visitors/:id` | เพิกถอน (เฉพาะ visitor ของบ้านตัวเอง) |

### Guest Code

- รูปแบบ `<house_code>+<สุ่ม 4 หลัก>` เช่น `9801+1234` งานส่วนกลาง (admin ออก ไม่มีบ้าน) ขึ้นต้น `0+` เช่น `0+5521`
- เลขเดียวกันใช้ได้ 2 แบบ: ทำเป็น QR (เนื้อหา QR = `9801+1234`) หรือกดที่ Keypad (`98011234`, `9801#1234`, `9801*1234`)
- `duration`: `1d` / `7d` / `14d` / `30d` / `1y` / `forever` (100 ปี)
- DB เก็บแค่ hash: โค้ดจริงคืนให้ **ครั้งเดียว** ตอนสร้าง LIFF ต้องแสดง / แชร์ทันที (เช่น `liff.shareTargetPicker`)
- เพิกถอนแล้วหรือหมดอายุแล้ว โค้ดเดิมไม่ถูกนำกลับมาใช้ซ้ำ

## CORS

`/api/v1/admin/*` และ `/api/v1/owner/*` ตอบ CORS เฉพาะ origin ที่อยู่ใน `ALLOWED_ORIGINS` (คั่นด้วย `,`)
API ของอุปกรณ์ (`/auth/device/token`, `/access/authorize`) ไม่มี CORS

## Audit Log

ทุกการแก้ไขข้อมูลโดย admin / owner (POST / PATCH / DELETE ที่สำเร็จ), login และการผูก LINE บันทึกใน `tb_audit_log`
(`actor_type`, `actor_id`, `action`, `target_id`, `detail`) โดยตัด `value`, `password`, `id_token`, `link_code` ออกจาก `detail`
ส่วนการตัดสินสิทธิ์ที่ไม้กั้นทุกครั้งอยู่ใน `tb_access_log`

## กติกาข้อมูล

- `tb_policy`: ไม่มีแถว = ไม่อนุญาต หลังเพิ่มโครงการใหม่ต้องรัน `../AAASQL/seeds/default_policy.sql`
  (`npx wrangler d1 execute db1-aaa --remote --file=../AAASQL/seeds/default_policy.sql`) รันซ้ำได้
  - ลูกบ้านปกติ: ANPR / RFID / QRCODE / PIN
  - ลูกบ้านค้างชำระ (`tb_house.payment_status = 'OVERDUE'`): RFID / PIN เท่านั้น ไม่ได้ห้ามเข้า แต่ไม่ได้ใช้ ANPR
  - ลูกบ้านค้างชำระต่อเนื่อง (`'OVERDUE_SEVERE'`): PIN เท่านั้น (ต้องกด Keypad)
  - การเลื่อนระดับ NORMAL → OVERDUE → OVERDUE_SEVERE ตอนนี้ admin / ระบบบิลเป็นคนแก้ `payment_status` เอง
  - Visitor: QRCODE / PIN (Guest Code ใช้ได้ทั้ง QR และ Keypad; ANPR ของ Visitor ต้องเพิ่มแถวเองรายโครงการ)
- ทะเบียนรถใน `tb_vehicle` / `tb_visitor` / `tb_blacklist` ต้องเก็บแบบไม่มีช่องว่างและ `-` (เช่น `กก9999`)
- `tb_device.device_secret_hash` = SHA-256 hex ของ device secret
- `tb_credential.cred_hash` = HMAC-SHA256(`CRED_PEPPER`, `project_id:cred_type:value`) ดู `credentialHash()` ใน `src/authorize.ts`
- เวลาใน `valid_from` / `valid_until` เป็น UTC
- `tb_user.line_user_id` = LINE userId จาก LIFF (ไม่ใช่ `line_id`) 1 บัญชี LINE ผูกได้กับลูกบ้าน 1 คนเท่านั้น
- PIN ของลูกบ้านห้ามซ้ำกับ Guest Code ที่ยังมีอยู่ (และกลับกัน) เพราะ Keypad ส่งมาเป็น method `PIN` เหมือนกัน
