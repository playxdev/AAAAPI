# AAAAPI — Axis Access Auto REST API v1.2.0

Intelligent residential access management backend. Built with **Go 1.23** and **Fiber v2**, backed by **Microsoft SQL Server**. Designed for multi-tenant gated communities with offline-capable edge-to-cloud synchronization.

Comes with `AAAADMIN` — a TypeScript admin SPA built with **Vite**, **Tailwind CSS v4**, and **View Transitions API**. Auto-built and served from the same process.

## Architecture

```
    AAAADMIN (Admin SPA)        Edge Devices        Mobile / Web Clients
          │                         │                      │
          │ static                  │ X-API-Key            │ JWT Bearer
          ▼                         ▼                      ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                     AAAAPI (Go / Fiber)                     │
   │                                                             │
   │  /              /api/v1/edge/*   /api/v1/*                  │
   │  (admin panel)  (API Key auth)  (JWT auth)                  │
   └──────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
                  ┌─────────────────────┐
                  │  MS SQL Server      │
                  │  Database: AAA      │
                  │  (8 tables, v1.2.0) │
                  └─────────────────────┘
```

## Prerequisites

- **Go** 1.23+
- **Node.js** + npm (for AAAADMIN frontend build)
- **Microsoft SQL Server** (hosted or local)
- Database schema applied from [`AAASQL/docs/AAA.sql`](../AAASQL/docs/AAA.sql)

## Quick Start

```bash
cd AAAAPI
cp .env.example .env         # edit credentials and secrets
go mod download              # install dependencies
go run main.go               # auto-builds AAAADMIN, starts on FIBER_PORT
```

The server auto-builds the admin frontend from `../AAAADMIN/` on first run and serves it at `/`. If the build fails, only the API is served.

## Environment Variables

| Variable       | Default                    | Description                        |
|--------------- |--------------------------- |----------------------------------- |
| `FIBER_PORT`   | `3000`                     | HTTP listen port                   |
| `DB_HOST`      | `localhost`                | MSSQL server host                  |
| `DB_PORT`      | `1433`                     | MSSQL port                         |
| `DB_USER`      | `sa`                       | MSSQL username                     |
| `DB_PASSWORD`  | *(required)*               | MSSQL password                     |
| `DB_NAME`      | `AAA`                      | MSSQL database name                |
| `DB_ENCRYPT`   | `disable`                  | MSSQL encryption (`disable`/`true`)|
| `JWT_SECRET`   | `default-secret-change-me` | HS256 signing key for JWT tokens   |
| `API_KEY`      | *(optional)*               | Shared secret for edge devices. If empty, edge routes are public. |
| `LOG_FILE`     | *(optional)*               | Transaction log file path          |

## Authentication

Three layers:

| Layer         | Mechanism                     | Used by                       |
|-------------- |------------------------------ |------------------------------ |
| **Admin**     | Bcrypt-hashed password in `tb_admin` | System administrators (admin panel login) |
| **JWT**       | `Authorization: Bearer <token>` | Mobile / Web clients          |
| **API Key**   | `X-API-Key: <key>`            | Edge / microcontroller devices |

### Admin Accounts

Admin accounts live in `tb_admin` with bcrypt-hashed passwords. Admin users log in via `POST /api/v1/auth/admin/login` using their `admin_name` and password. **There is no API endpoint for creating admin accounts** — they are created exclusively via manual SQL:

```sql
INSERT INTO tb_admin (admin_id, project_id, admin_name, admin_password, admin_level)
VALUES ('admin', 'PRJ0001', 'admin', '<bcrypt-hash>', 'ADMIN');
```

Generate the bcrypt hash with:

```bash
htpasswd -nbBC 10 admin vXrz0013 | cut -d: -f2
```

See [`AAASQL/README.md`](../AAASQL/README.md) for full instructions.

### JWT Tokens

Obtained via `POST /api/v1/auth/login`. Tokens carry `user_id`, `project_id`, and `role` claims with 24-hour expiry.

---

## API Endpoints

### Public

#### `GET /api/v1/health`
```
200 {"status":"ok"}
```

#### `POST /api/v1/auth/login`
Request:
```json
{"user_id":"USR-20260628002538","phone_number":"0812345678"}
```
Response (200):
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user_id": "USR-20260628002538",
  "full_name": "Somchai Jaidee",
  "role": "RESIDENT"
}
```
Invalid credentials return `401 {"error":"invalid credentials"}`.

#### `POST /api/v1/auth/admin/login`
Admin login using `tb_admin` credentials with bcrypt password verification.
Request:
```json
{"admin_name":"admin","password":"secret"}
```
Response (200):
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "admin_id": "ADM00001",
  "full_name": "admin",
  "role": "ADMIN"
}
```
Invalid credentials return `401 {"error":"invalid credentials"}`.

### Edge — API Key auth (public if `API_KEY` is empty)

#### `GET /api/v1/edge/sync/pull?project_id=<id>`
Pulls all authorized active data for offline caching. Returns vehicles, users, devices, and blacklist entries scoped to the project.
```
200 {"project_id":"PRJ-...","synced_at":"...","data":{"vehicles":[...],"users":[...],"devices":[...],"blacklist":[...]}}
```
Requires `project_id` query parameter. Returns `400` if missing.

#### `POST /api/v1/edge/sync/push`
Pushes batched access logs from edge to cloud in a single database transaction. All logs share one `device_id`.
Request:
```json
{
  "project_id": "PRJ-20260628002538",
  "device_id": "DEV-20260628002538",
  "logs": [
    {
      "license_plate": "กข1234",
      "access_type": "LPR",
      "user_type": "RESIDENT",
      "is_success": true,
      "remark": "Edge sync push test",
      "access_date": "2026-06-28T00:00:00Z",
      "image_url": ""
    }
  ]
}
```
Response (201):
```json
{"message":"synced 1 logs","data":{"synced_count":1}}
```
`device_id` is a **top-level field**; it must reference an existing `tb_device.device_id`.

#### `GET /api/v1/edge/validate/:plate?project_id=<id>`
Real-time license plate validation. Checks blacklist first, then registered vehicles.
```
200 {"allowed":true,"reason":"registered","license_plate":"กข1234","user_id":"USR-...","full_name":"Somchai Jaidee","house_number":"88/1","access_type":"GRANTED"}
200 {"allowed":false,"reason":"Previous incident","license_plate":"9999XX","access_type":"DENIED"}
200 {"allowed":false,"reason":"unknown","license_plate":"กข9999","access_type":"UNKNOWN"}
```
Requires `project_id` query parameter.

#### `GET /api/v1/edge/check/:plate?project_id=<id>`
Quick blacklist lookup. Returns `200 {"blacklisted":true,"blacklist_id":"BLK-...","reason":"..."}` or `200 {"blacklisted":false}`.

### Protected — JWT auth

All endpoints below require `Authorization: Bearer <token>`. Data is automatically scoped to the caller's `project_id` from the JWT claim.

#### Projects
| Method   | Path                     | Description        |
|--------- |------------------------- |------------------- |
| `GET`    | `/api/v1/projects`       | List all projects  |
| `GET`    | `/api/v1/projects/:id`   | Get one project    |
| `POST`   | `/api/v1/projects`       | Create project     |
| `PUT`    | `/api/v1/projects/:id`   | Update project     |
| `DELETE` | `/api/v1/projects/:id`   | Soft-delete        |

#### Houses
| Method   | Path                    | Description       |
|--------- |------------------------ |------------------ |
| `GET`    | `/api/v1/houses`        | List all houses   |
| `GET`    | `/api/v1/houses/:id`    | Get one house     |
| `POST`   | `/api/v1/houses`        | Create house      |
| `PUT`    | `/api/v1/houses/:id`    | Update house      |
| `DELETE` | `/api/v1/houses/:id`    | Soft-delete       |

#### Users
| Method   | Path                   | Description      |
|--------- |----------------------- |----------------- |
| `GET`    | `/api/v1/users`        | List all users   |
| `GET`    | `/api/v1/users/:id`    | Get one user     |
| `POST`   | `/api/v1/users`        | Create user      |
| `PUT`    | `/api/v1/users/:id`    | Update user      |
| `DELETE` | `/api/v1/users/:id`    | Soft-delete      |

#### Vehicles
| Method   | Path                      | Description         |
|--------- |-------------------------- |-------------------- |
| `GET`    | `/api/v1/vehicles`        | List all vehicles   |
| `GET`    | `/api/v1/vehicles/:id`    | Get one vehicle     |
| `POST`   | `/api/v1/vehicles`        | Create vehicle      |
| `PUT`    | `/api/v1/vehicles/:id`    | Update vehicle      |
| `DELETE` | `/api/v1/vehicles/:id`    | Soft-delete         |

#### Devices
| Method   | Path                      | Description         |
|--------- |-------------------------- |-------------------- |
| `GET`    | `/api/v1/devices`         | List all devices    |
| `GET`    | `/api/v1/devices/:id`     | Get one device      |
| `POST`   | `/api/v1/devices`         | Create device       |
| `PUT`    | `/api/v1/devices/:id`     | Update device       |
| `DELETE` | `/api/v1/devices/:id`     | Soft-delete         |

#### Access Logs
| Method | Path                        | Description          |
|------- |---------------------------- |--------------------- |
| `GET`  | `/api/v1/access-logs`       | List all access logs |
| `GET`  | `/api/v1/access-logs/:id`   | Get one access log   |
| `POST` | `/api/v1/access-logs`       | Create access log    |

#### Blacklist
| Method   | Path                             | Description                              |
|--------- |--------------------------------- |----------------------------------------- |
| `GET`    | `/api/v1/blacklist`              | List all blacklist entries               |
| `GET`    | `/api/v1/blacklist/:id`          | Get one entry                            |
| `POST`   | `/api/v1/blacklist`              | Create entry                             |
| `PUT`    | `/api/v1/blacklist/:id`          | Update entry                             |
| `DELETE` | `/api/v1/blacklist/:id`          | Soft-delete                              |
| `GET`    | `/api/v1/blacklist/check/:plate` | Check plate (requires `?project_id=...`) |

---

## Directory Structure

```
aaa/
├── AAASQL/                    # Database schema & docs
│   ├── README.md
│   └── docs/
│       ├── AAA.sql            # Full DDL (v1.1.5)
│       ├── CONCEPT.md         # Requirements & architecture
│       └── STANDARD.md        # Naming & design standards
├── AAAAPI/                    # Go REST API (this repo)
│   ├── main.go               # Entry point; auto-builds AAAADMIN
│   ├── go.mod / go.sum        # Module: aaaapi
│   ├── .env.example           # Environment template
│   ├── config/
│   │   └── config.go          # Env loader (godotenv)
│   ├── database/
│   │   └── database.go        # MSSQL via sqlx (25 open / 10 idle)
│   ├── model/
│   │   └── model.go           # Structs, DTOs, request/response types
│   ├── handler/
│   │   ├── auth.go            # Login / JWT (HS256, 24h)
│   │   ├── project.go         # Project CRUD
│   │   ├── house.go           # House CRUD
│   │   ├── user.go            # User CRUD
│   │   ├── vehicle.go         # Vehicle CRUD
│   │   ├── device.go          # Device CRUD
│   │   ├── access_log.go      # Access log CRUD
│   │   ├── blacklist.go       # Blacklist CRUD + check
│   │   ├── edge.go            # Edge sync (pull/push/validate)
│   │   ├── test_helper.go     # Test utilities
│   │   └── *_test.go          # Unit tests
│   ├── middleware/
│   │   ├── middleware.go      # CORS, Logger, Recover, 404, AdminStatic
│   │   ├── auth.go            # JWT + API Key middleware
│   │   └── auth_test.go
│   └── router/
│       └── router.go          # Route registration
└── AAAADMIN/                  # TypeScript admin SPA (v1.2.0)
    ├── index.html              # HTML shell with Google Sans font
    ├── package.json            # v1.2.0
    ├── vite.config.ts          # Vite + Tailwind CSS v4 + /api proxy
    ├── tsconfig.json
    ├── dist/                   # Built output (served by AAAAPI)
    └── src/
        ├── main.ts             # Entry point
        ├── router.ts           # Hash-based client-side router
        ├── api.ts              # HTTP client (/api/v1)
        ├── auth.ts             # JWT + admin login
        ├── theme.ts            # Dark/light mode + View Transitions API
        ├── types.ts            # TypeScript interfaces
        ├── toast.ts            # Toast notifications
        ├── style.css           # Tailwind + custom styles + CSS variables
        ├── utils.ts            # Shared utilities (escapeHtml, etc.)
        ├── components/         # Reusable UI components
        │   ├── layout.ts       # Main layout (sidebar + header + main + footer)
        │   ├── sidebar.ts      # Left navigation (collapsible)
        │   ├── header.ts       # Top bar (page title, theme toggle, hamburger)
        │   ├── footer.ts       # Bottom bar (copyright, version, system status)
        │   ├── modal.ts        # Confirm/alert styled modal dialogs
        │   └── table-footer.ts # Pagination + data summary
        └── pages/              # Page-specific content
            ├── login.ts        # Admin login form
            ├── dashboard.ts    # Stats + recent access logs
            ├── projects.ts     # Project CRUD
            ├── houses.ts       # House CRUD
            ├── users.ts        # User CRUD
            ├── vehicles.ts     # Vehicle CRUD
            ├── devices.ts      # Device CRUD
            ├── access-logs.ts  # Access log viewer
            └── blacklist.ts    # Blacklist CRUD
```

## Edge-to-Cloud Sync Flow

```
  ┌─────────────┐           ┌─────────────┐           ┌─────────────┐
  │  Edge Device │           │  AAAAPI     │           │  MSSQL      │
  │  (on-prem)  │           │  (cloud)    │           │  (cloud)    │
  └──────┬──────┘           └──────┬──────┘           └──────┬──────┘
         │                         │                         │
         │  GET /edge/sync/pull?project_id=X                  │
         │────────────────────────>│ ─ ─ SELECT active data ─>│
         │<── vehicles, users,     │<── rows ─ ─ ─ ─ ─ ─ ─│
         │    devices, blacklist   │                         │
         │                         │                         │
    ┌────▼──── offline operation   │                         │
    │  cache  │ using local data   │                         │
    └────┬────┘                    │                         │
         │                         │                         │
         │  POST /edge/sync/push   │                         │
         │  {project_id, device_id,│                         │
         │   logs:[...]}           │                         │
         │────────────────────────>│ ─ ─ INSERT in TX ─ ─ ─>│
         │<──── 201 Created ───────│<── committed ─────────│
```

1. **Pull** — Edge devices request active authorized data and cache it locally.
2. **Offline** — Gates operate using cached data; access logs accumulate locally.
3. **Push** — Pending logs synced in a single DB transaction once connectivity returns.
4. **Validate** — Real-time plate check: blacklist → registered vehicle → UNKNOWN.

## Testing

```bash
go test ./...        # all unit tests
go test ./... -v     # verbose
go test ./... -cover # with coverage
```

All handlers and middleware have unit tests using `sqlmock` for database isolation and `testify` for assertions. No real database required for tests.

## Database

See [`AAASQL/docs/AAA.sql`](../AAASQL/docs/AAA.sql) for the full schema (8 tables, v1.2.0). All tables use soft-delete (`is_active`, `is_delete`) with auto-update triggers on `update_date`. Admin accounts use bcrypt password hashing in `tb_admin`.

## License

Proprietary. All rights reserved.
