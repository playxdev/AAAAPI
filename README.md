# AAAAPI — Axis Auto Access API (Cloudflare Workers)

Backend ตรวจสิทธิ์เข้า-ออก + Admin API + Owner API (LINE LIFF) เขียนด้วย TypeScript บน Cloudflare Workers + D1
ภาพรวมระบบ / tech stack: repo **AAACLOUDF** · Schema: repo **AAASQL**

Production: `https://aaa-api.cookievirus.workers.dev`

## โครงสร้าง

```
src/index.ts                 routing, CORS, device token, authorize endpoint, access log
src/authorize.ts             ตัดสินสิทธิ์ (ANPR / credential / Guest Code / policy)
src/admin.ts                 Admin API: login, บ้าน + ผู้ติดต่อ, รถ / บัตร / PIN / QR ของบ้าน, Visitor, รหัสผูก LINE
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
CLOUDFLARE_ACCOUNT_ID=30ec5dca725dd7acef6a6ef89342e403 npx wrangler d1 migrations apply aaa-d1 --remote
npm run deploy
```

wrangler 4.156.0: คำสั่ง `d1 migrations ...` ไม่อ่าน `account_id` จาก `wrangler.jsonc` (login นี้เห็น 2 บัญชี)
ต้องใส่ `CLOUDFLARE_ACCOUNT_ID` เอง คำสั่งอื่น (`deploy`, `d1 execute`, `d1 info`) ใช้ค่าใน `wrangler.jsonc` ได้

Schema / migrations / seed อยู่ใน repo [AAASQL](https://github.com/playxdev/AAASQL) (`migrations_dir` = `../AAASQL/migrations`)
ต้อง clone AAAAPI กับ AAASQL ไว้ใน folder เดียวกัน ทั้ง `wrangler` และ `npm test` อ่าน migration จากที่นั่น

Production: `https://aaa-api.cookievirus.workers.dev` (บัญชี Cookievirus, D1 `aaa-d1` region APAC)
Secrets `JWT_SECRET` / `CRED_PEPPER` ตั้งแล้วด้วยค่าสุ่ม ไม่มีสำเนาที่อื่น ห้ามเปลี่ยน `CRED_PEPPER` (credential ทั้งหมดจะใช้ไม่ได้)

สถานะ production (2026-11-25, beta):
- Migration `0001`–`0007` apply แล้ว, policy seed แล้ว (`0007` apply 2026-11-26 bookmark ก่อน apply `00000008-00000000-0000512e-79bb87346a142d79467dc3f23d3f5ab5`; `0006` apply 2026-11-26 bookmark ก่อน apply `00000006-00000000-0000512e-973be42f89af91dde1fb5e13e5b5897f`; Time Travel bookmark ก่อน apply
  `0004` = สิทธิ์เข้าออกเป็นของบ้าน: `00000002-00000000-0000512e-1d3fb267a62c19c8230ce52ff558934c`,
  `0005` = รหัสโครงการ: `00000003-00000000-0000512e-4eeff727b4aa67764011d2ed1af98f5f`)
- Device ทดสอบของ SEMA: `SEMA-000-01` (`PRJ-000`, ทางเข้า)
- โครงการ `PRJ-000` รหัสโครงการ `PROJ-0001` (หมู่บ้านทดสอบ) + admin `admin` (`ADM-001`)
- Root: โครงการ `PRJ-PLAY` รหัส `PLAY-0013` (PlayDevX) + `root` (`ADM-ROOT`, ref `PLAY-0013-R01`) จัดการทุกโครงการ
- ล้างข้อมูลทดสอบแล้ว 2026-11-12 (เหลือโครงการ, admin, policy) ข้อมูลยังเป็น beta ล้างได้
- `ALLOWED_ORIGINS` = `https://aaa-admin.pages.dev` (Admin WebApp, ตรงกันทั้งตัว URL preview ของ Pages ใช้ไม่ได้)
- ยังว่าง: `LINE_CHANNEL_ID` (LIFF ยังเรียก API ไม่ได้)
- ยังไม่มี rate limit ที่ `/admin/login`, `/owner/*`, `/auth/device/token` (`workers.dev` ตั้ง WAF ไม่ได้
  ต้องใช้ Workers Rate Limiting binding หรือย้ายไปโดเมนของตัวเอง)

### สร้างโครงการ + Admin คนแรก

ทุกโครงการ (หมู่บ้าน / คอนโด / อาคาร / สถานที่) ใช้ DB ร่วมกัน แยกด้วย `project_id`
Root (`ROOT`, PlayDevX) สร้างโครงการ + Admin ได้จากหน้า "โครงการ" ใน Admin WebApp หรือ `POST /api/v1/admin/projects`, `/admins`
Root เพิ่มด้วย SQL เท่านั้น (`admin_level = 'ROOT'` ในโครงการ `PRJ-PLAY`)

Admin login ด้วย **รหัสโครงการ** `AAAA-AA11` (ชื่อย่อ A–Z 4 ตัว + สาขา / ลำดับ A–Z 0–9 4 ตัว เช่น `PROJ-0001`, `SNTW-BK01`)
เก็บใน `tb_project.project_code` แบบตัวใหญ่ + ขีด ห้ามซ้ำ; `admin_name` ห้ามซ้ำเฉพาะในโครงการเดียวกัน

```sh
npx wrangler d1 execute aaa-d1 --remote --command \
  "INSERT INTO tb_project (project_id, project_name, project_code) VALUES ('<project_id>', '<ชื่อโครงการ>', 'SNTW-BK01')"
npx wrangler d1 execute aaa-d1 --remote --file=../AAASQL/seeds/default_policy.sql
node scripts/hash-password.mjs        # พิมพ์รหัสผ่าน (อย่างน้อย 12 ตัวอักษร) ได้ hash pbkdf2_sha256$...
npx wrangler d1 execute aaa-d1 --remote --command \
  "INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password) VALUES ('<admin_id>', '<project_id>', '<admin_name>', '<hash>')"
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
{ "event_id": "evt-unique-id", "method": "ANPR", "value": "กก9999", "province": "กรุงเทพมหานคร", "house_code": "9801", "direction": "ENTRY" }
```
→ `{ "event_id": "...", "decision": "YES|NO|ERROR", "house_number": "98/6", "reason_code": "...", "allowed_methods": ["RFID"], "policy_version": 1 }`

- `house_number` = บ้านเลขที่ของเจ้าของ input ส่งเมื่อ `YES` (`NO` / Visitor งานส่วนกลาง = `null`) SEMA ใช้แค่ `decision` + `house_number` ก็พอ

- `method`: `ANPR` / `RFID` / `QRCODE` / `PIN`
- `event_id` ซ้ำ → ได้คำตอบเดิม ไม่ตัดสินซ้ำ
- `ERROR` ตอบ HTTP 500 และห้ามตีความเป็น `YES`
- `house_code` ไม่บังคับ: ใช้ตรวจซ้ำว่า credential / ทะเบียนเป็นของบ้านนั้น ไม่ตรง → `NO` + `HOUSE_MISMATCH` รูปแบบผิด → 400
- `direction` ไม่บังคับ: `ENTRY` / `EXIT` บันทึกลง `tb_access_log.access_type` (SEMA ตัวเดียวคุมทั้งฝั่งเข้า/ออก) ไม่ส่ง → ใช้ `tb_device.direction` ค่าอื่น → 400
- `province` ไม่บังคับ (ANPR เท่านั้น): จังหวัดที่กล้องอ่านได้ ใช้แยกรถเมื่อทะเบียนเดียวกันลงทะเบียนไว้หลายจังหวัด
  ทะเบียนที่มีคันเดียวไม่สน `province` (กัน OCR จังหวัดผิด) แยกไม่ได้ → `NO` + `PLATE_AMBIGUOUS` (`กทม` / `กรุงเทพฯ` = `กรุงเทพมหานคร`)
- บ้านที่ปิดใช้งาน (`tb_house.is_active = 0`): ทุกช่องทางของบ้านได้ `USER_INACTIVE`, Visitor ของบ้านนั้นได้ `VISITOR_NOT_VALID` (ทะเบียน = `UNKNOWN_PLATE`)
- บ้านไม่มีผู้อยู่อาศัย (`tb_house.occupancy_status = 'VACANT'`): รถ / บัตร / PIN / QR / Guest Code ของบ้านได้ `HOUSE_VACANT` (ทะเบียน Visitor = `UNKNOWN_PLATE`)

`reason_code`: `RESIDENT_ACTIVE`, `RESIDENT_OVERDUE_ALLOWED`, `VISITOR_VALID`, `RESIDENT_OVERDUE`, `RESIDENT_OVERDUE_SEVERE`,
`METHOD_NOT_ALLOWED`, `BLACKLISTED`, `UNKNOWN_PLATE`, `UNKNOWN_CREDENTIAL`, `CREDENTIAL_REVOKED`,
`CREDENTIAL_NOT_YET_VALID`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_USED_UP`, `USER_INACTIVE`, `HOUSE_VACANT`, `VISITOR_NOT_VALID`,
`PLATE_AMBIGUOUS`, `HOUSE_MISMATCH`, `TOO_MANY_ATTEMPTS`, `INTERNAL_ERROR`, `LOG_FAILED`

`TOO_MANY_ATTEMPTS`: อุปกรณ์เดียวกันส่ง PIN / QR ที่ไม่รู้จัก (หรือ `HOUSE_MISMATCH`) ครบ 10 ครั้งใน 5 นาที จะปฏิเสธ PIN / QR ของอุปกรณ์นั้นจนพ้นช่วงเวลา
(กันสุ่ม Guest Code) ANPR และ RFID ยังใช้ได้

## Admin API

ทุก endpoint (ยกเว้น login) ต้องส่ง Header `Authorization: Bearer <admin JWT>`
`project_id` มาจาก token เสมอ admin โครงการอื่นจะได้ `404` เหมือนไม่มีข้อมูล

ระดับผู้ดูแล (`tb_admin.admin_level`):
- `ROOT` = PlayDevX (โครงการ `PLAY-0013`) จัดการได้ทุกโครงการ: ส่ง Header `X-Project-Code: PROJ-0001` เพื่อทำงานในโครงการนั้น
  (ไม่ส่ง = โครงการของตัวเอง, ไม่พบ → `404 PROJECT_NOT_FOUND`); สร้างโครงการ / Admin ได้; Root เพิ่มด้วย SQL เท่านั้น
- `ADMIN` = ประจำโครงการ (Header `X-Project-Code` ถูกเมิน); `/projects`, `/admins` → `403 FORBIDDEN`
- รหัสที่ Root สร้าง / รีเซ็ตให้ (`must_change_password = 1`): เรียกได้แค่ `POST /me/password` อื่น ๆ → `403 PASSWORD_CHANGE_REQUIRED`

| Method | Endpoint | Body / หมายเหตุ |
|---|---|---|
| `POST` | `/api/v1/admin/login` | `{ project_code, admin_name, password }` → `{ access_token, expires_in: 3600, project_code, project_name, admin_level, must_change_password }`; รหัสโครงการไม่สนตัวเล็กใหญ่ / ขีด, รูปแบบผิด → `400`, โครงการ / ชื่อ / รหัสผ่านผิด หรือโครงการปิดใช้งาน → `401 INVALID_LOGIN` (ไม่บอกว่าผิดช่องไหน) |
| `GET` | `/api/v1/admin/houses` | รายการบ้าน + `contacts[]` (เจ้าบ้านขึ้นก่อน = ผู้ติดต่อหลัก) |
| `POST` | `/api/v1/admin/houses` | `{ house_number, house_code?, zone_or_soi?, occupancy_status? }` |
| `GET` | `/api/v1/admin/houses/:id` | บ้าน + `contacts` + `vehicles` + `credentials` (ไม่มี hash / ค่าจริง) |
| `PATCH` | `/api/v1/admin/houses/:id` | `{ house_number?, house_code?, zone_or_soi?, payment_status?, occupancy_status?, is_active? }` |
| `POST` | `/api/v1/admin/houses/:id/contacts` | `{ full_name, phone_number?, role? }` → `{ user_id, ref, role }`; `role` = `OWNER` (ค่าเริ่มต้น) / `FAMILY` / `RESIDENT` / `TENANT` |
| `PATCH` | `/api/v1/admin/contacts/:id` | `{ full_name?, phone_number?, role? }` ตั้งเป็น `OWNER` = เจ้าบ้านเดิมกลายเป็น `RESIDENT` อัตโนมัติ (บัญชี LINE ของทั้งคู่ใช้ต่อได้) |
| `DELETE` | `/api/v1/admin/contacts/:id` | ลบผู้ติดต่อ (soft delete) ไม่กระทบสิทธิ์เข้าออกของบ้าน บัญชี LINE ของเขาใช้ไม่ได้ |
| `POST` | `/api/v1/admin/contacts/:id/link-code` | ออกรหัสผูก LINE 8 ตัว ใช้ครั้งเดียว อายุ 24 ชม. → `{ user_id, link_code }` |
| `POST` | `/api/v1/admin/houses/:id/vehicles` | `{ license_plate, province?, brand?, color? }` ดู "ทะเบียนรถ" ด้านล่าง |
| `DELETE` | `/api/v1/admin/vehicles/:id` | ปิดใช้งานรถ |
| `POST` | `/api/v1/admin/houses/:id/credentials` | `{ cred_type: RFID\|QRCODE\|PIN, value?, label?, duration?, valid_from?, valid_until? }` ดู "บัตร / PIN / QR" ด้านล่าง |
| `DELETE` | `/api/v1/admin/credentials/:id` | เพิกถอน (`REVOKED`) |
| `GET` | `/api/v1/admin/visitors` | `?house_id=` / `?valid=1` (เฉพาะที่ยังไม่หมดอายุ) |
| `POST` | `/api/v1/admin/visitors` | `{ duration, house_id?, full_name?, phone_number?, license_plate?, purpose?, issue_code? }` ไม่ส่ง `house_id` = งานส่วนกลาง, บ้าน `VACANT` → `409 HOUSE_VACANT` |
| `DELETE` | `/api/v1/admin/visitors/:id` | เพิกถอน visitor + Guest Code |
| `GET` | `/api/v1/admin/projects` | **ROOT** ทุกโครงการ + จำนวนบ้าน / admin |
| `POST` | `/api/v1/admin/projects` | **ROOT** `{ project_code, project_name }` สร้างโครงการ + policy ตั้งต้น; ซ้ำ → `409` |
| `GET` | `/api/v1/admin/admins` | **ROOT** ผู้ดูแลทุกโครงการ (`ref`, `admin_level`) |
| `POST` | `/api/v1/admin/admins` | **ROOT** `{ project_code, admin_name, password }` สร้าง `ADMIN` (รหัสผ่าน ≥ 12 ตัว) → `{ admin_id, ref }` เช่น `SNTW-BK01-A01`; ชื่อซ้ำในโครงการ → `409 ADMIN_EXISTS` |
| `DELETE` | `/api/v1/admin/admins/:id` | **ROOT** ปิดใช้งาน `ADMIN` |
| `POST` | `/api/v1/admin/admins/:id/reset-password` | **ROOT** ลืมรหัสผ่าน: ตั้งรหัสสุ่ม 16 ตัวให้ `ADMIN` → `{ password }` (คืนครั้งเดียว) และบังคับเปลี่ยน |
| `POST` | `/api/v1/admin/me/password` | `{ current_password, new_password }` เปลี่ยนรหัสของตัวเอง (≥ 12 ตัว ไม่ซ้ำรหัสเดิม); รหัสเดิมผิด → `400 WRONG_PASSWORD` |

- สิทธิ์เข้าออก (รถ / บัตร / PIN / QR) เป็นของ **บ้าน** ไม่ใช่ของคน; `tb_user` = ผู้ติดต่อของบ้าน + บัญชี LINE
- `payment_status`: `NORMAL` / `OVERDUE` / `OVERDUE_SEVERE`
- `occupancy_status`: `OCCUPIED` (ค่าเริ่มต้น) / `VACANT` = ไม่มีผู้อยู่อาศัย: เพิ่มรถ / บัตร / Visitor ไม่ได้ (`409 HOUSE_VACANT`) และของเดิมใช้ไม่ได้จนกลับเป็น `OCCUPIED`
- ทะเบียนรถ: หมวด + เลข 1–4 หลัก (`กข 1234`, `1กข 1234`, `รวย 9999`, `จ 12`) หรือรถบรรทุก / รถโดยสาร `70-1234` (เลข 2 + 4 หลัก)
  ไม่ตรง → `400` (`field: license_plate`); เก็บแบบตัดช่องว่าง / ขีด; จังหวัดเก็บเป็นชื่อเต็ม
  ทะเบียนเดียวกันต่างจังหวัด = คนละคัน; ซ้ำในจังหวัดเดียวกัน (หรือฝั่งใดไม่ระบุจังหวัด) → `409 PLATE_EXISTS`
- บัตร / PIN / QR (กติกาเดียวกันทั้ง Admin และ Owner API ใน `src/access.ts`):
  - **PIN** = `house_code` + 4 หลัก เช่น `98061234` (กดที่ Keypad ทั้งหมด); `value` = 4 หลัก หรือไม่ส่ง = สุ่ม
  - **QRCODE** = `house_code` + 20 ตัวจาก `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` เช่น `9806P5MJ3G3CC5SCM5RASM4M` (เนื้อ QR ทั้งหมด);
    `value` = 20 ตัวหลัง หรือไม่ส่ง = สุ่ม; บ้านไม่มี `house_code` → `409 HOUSE_CODE_MISSING`
  - PIN / QR คืน `value` เต็มครั้งเดียวใน response; ใช้งานอยู่ได้ไม่เกิน **20 ชุดต่อบ้านต่อชนิด** → `409 LIMIT_REACHED` (ต้องเพิกถอนก่อน)
  - **RFID** เฉพาะ Admin / Root (`value` = เลขบัตร, ไม่คืนค่า)
  - `label` (≤ 32 ตัว) ชื่อสั้น เช่น "บัตรแม่", "pin ส่งของ"; `issued_by_type` / `issued_by_id` = ผู้สร้าง (`ADMIN` / `OWNER` = คนในบ้าน)
  - ค่าซ้ำในโครงการ (รวม PIN ชน Guest Code) → `409 CREDENTIAL_EXISTS`; Admin / Root เพิกถอนได้ทุกรายการ
  อายุ: `valid_until` (กำหนดเอง) > `duration` (`1d` / `7d` / `14d` / `30d` / `1y` / `forever` = ไม่มีวันหมดอายุ) > ไม่ส่ง = 24 ชั่วโมง
- `house_code`: ตัวเลข 1–6 หลัก ไม่ขึ้นต้นด้วย 0 ไม่ซ้ำในโครงการ ต้องมีก่อนบ้านนั้นจะออก Guest Code ได้
- Error: `{ "error": "BAD_REQUEST", "field": "<ชื่อ field>" }`, `NOT_FOUND`, `PLATE_EXISTS`, `CREDENTIAL_EXISTS`,
  `HOUSE_CODE_MISSING`, `HOUSE_VACANT`, `GUEST_CODE_UNAVAILABLE`, `CONFLICT`, `UNAUTHORIZED`
- ค่าของ RFID / QR / PIN ถูก hash ทันที อ่านค่าจริงกลับจาก API ไม่ได้

## Owner API (LINE Mini App)

สำหรับคนในบ้านทุกสถานะ (`OWNER` เจ้าบ้าน / `FAMILY` ลูกบ้าน / `RESIDENT` ผู้พักอาศัย / `TENANT` ผู้เช่า) เรียกจาก LINE Mini App (AAAAPP)
ส่ง ID Token (`liff.getIDToken()`) มาแลก JWT; ไม่คืนรหัสโครงการ / `project_id`

คนในบ้านมี `ref` ไม่ซ้ำทั้งระบบ เช่น `PROJ-0001-9806-01` (เจ้าบ้าน), `-02`, `-03` …; เจ้าบ้านมีได้ 1 คนต่อบ้าน

ผูกบัญชีครั้งแรก:
1. Admin สร้างเจ้าบ้าน (`POST /houses/:id/contacts`) แล้ว `POST /api/v1/admin/contacts/:id/link-code` ส่งรหัสให้เจ้าบ้าน
2. เจ้าบ้านกรอกรหัสใน Mini App → `POST /api/v1/owner/link`
3. เจ้าบ้านเชิญสมาชิก `POST /api/v1/owner/members` ได้รหัสเชิญ ส่งให้สมาชิกกรอกใน Mini App (`/owner/link` เหมือนกัน)
4. ครั้งต่อไปเรียก `POST /api/v1/owner/login` ได้เลย

| Method | Endpoint | Body / หมายเหตุ |
|---|---|---|
| `POST` | `/api/v1/owner/link` | `{ id_token, link_code }` → JWT; รหัสผิด / หมดอายุ → `400 INVALID_LINK_CODE`, LINE ผูกกับคนอื่นแล้ว → `409` |
| `POST` | `/api/v1/owner/login` | `{ id_token }` → JWT; ยังไม่ผูก → `403 NOT_LINKED` |
| `GET` | `/api/v1/owner/me` | ตัวเอง (`ref`, `role`) + บ้าน + `house_code` + `occupancy_status` |
| `GET` | `/api/v1/owner/house` | `me` + `members` + `vehicles` (ดูอย่างเดียว) + `credentials` (`label`, ผู้สร้าง, `mine` = ลบได้) |
| `POST` | `/api/v1/owner/members` | **OWNER** `{ full_name, phone_number?, role: FAMILY\|RESIDENT\|TENANT }` → `{ user_id, ref, link_code }` (รหัสเชิญใช้ครั้งเดียว 24 ชม.); อื่น → `403 OWNER_ONLY` |
| `POST` | `/api/v1/owner/members/:id/link-code` | **OWNER** ออกรหัสเชิญใหม่ |
| `DELETE` | `/api/v1/owner/members/:id` | **OWNER** ลบสมาชิก (ลบเจ้าบ้านไม่ได้) |
| `POST` | `/api/v1/owner/credentials` | `{ cred_type: PIN\|QRCODE, value?, label?, duration? }` กติกาเดียวกับ Admin (RFID ไม่ได้) |
| `DELETE` | `/api/v1/owner/credentials/:id` | ลบได้เฉพาะที่ตัวเองสร้าง |
| `GET` | `/api/v1/owner/visitors` | visitor ของบ้านตัวเองเท่านั้น (`?valid=1`) |
| `POST` | `/api/v1/owner/visitors` | `{ duration, full_name?, phone_number?, license_plate?, purpose? }` → `{ visitor_id, code, valid_until }`; บ้าน `VACANT` → `409 HOUSE_VACANT` |
| `DELETE` | `/api/v1/owner/visitors/:id` | เพิกถอนได้เฉพาะ visitor ที่ตัวเองออก |

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
  (`npx wrangler d1 execute aaa-d1 --remote --file=../AAASQL/seeds/default_policy.sql`) รันซ้ำได้
  - ลูกบ้านปกติ: ANPR / RFID / QRCODE / PIN
  - ลูกบ้านค้างชำระ (`tb_house.payment_status = 'OVERDUE'`): RFID / PIN เท่านั้น ไม่ได้ห้ามเข้า แต่ไม่ได้ใช้ ANPR
  - ลูกบ้านค้างชำระต่อเนื่อง (`'OVERDUE_SEVERE'`): PIN เท่านั้น (ต้องกด Keypad)
  - การเลื่อนระดับ NORMAL → OVERDUE → OVERDUE_SEVERE ตอนนี้ admin / ระบบบิลเป็นคนแก้ `payment_status` เอง
  - Visitor: QRCODE / PIN (Guest Code ใช้ได้ทั้ง QR และ Keypad; ANPR ของ Visitor ต้องเพิ่มแถวเองรายโครงการ)
- ทะเบียนรถใน `tb_vehicle` / `tb_visitor` / `tb_blacklist` ต้องเก็บแบบไม่มีช่องว่างและ `-` (เช่น `กก9999`)
- `tb_device.device_secret_hash` = SHA-256 hex ของ device secret
- `tb_credential.cred_hash` = HMAC-SHA256(`CRED_PEPPER`, `project_id:cred_type:value`) ดู `credentialHash()` ใน `src/authorize.ts`
- เวลาใน `valid_from` / `valid_until` เป็น UTC
- `tb_user.line_user_id` = LINE userId จาก LIFF (ไม่ใช่ `line_id`) 1 บัญชี LINE ผูกได้กับผู้ติดต่อ 1 คนเท่านั้น
- PIN ของบ้านห้ามซ้ำกับ Guest Code ที่ยังมีอยู่ (และกลับกัน) เพราะ Keypad ส่งมาเป็น method `PIN` เหมือนกัน
