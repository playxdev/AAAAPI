# Changelog

## v1.2.0 (2026-07-03)

### Changed

- **Business ID generation moved to database triggers** — application no longer generates IDs.
  - ID format changed from `{PREFIX}-YYYYMMDDHHmmss` to `{PREFIX}-YYYYMMDD-XXXXXX` (date + 6 random hex chars).
  - All `Create()` handlers use `OUTPUT INSERTED.{id}` to capture DB-generated IDs.
  - Edge push logs no longer append sequence counters; trigger handles each `log_id`.
- `AdminLoginResponse` now includes `project_id` field so the frontend can filter data by admin's assigned project.
- Removed `"time"` and `"fmt"` imports from handlers that no longer generate IDs locally.

### Upstream

- Requires `AAASQL/docs/AAA.sql` v1.2.0+ (new `INSTEAD OF INSERT` triggers).

---

## v1.1.0 (2026-06-28)

### Added

- `tb_admin` table — admin accounts with bcrypt password hashing
  - `admin_id` (business ID), `admin_name` (login username), `admin_password` (bcrypt), `admin_level`
  - FK to `tb_project`, auto-update trigger, index on `project_id`
- AAAADMIN TypeScript admin SPA — auto-built and served by the API
  - Dashboard, Projects, Houses, Users, Vehicles, Devices, Access Logs, Blacklist pages
  - JWT-based authentication via `/api/v1/auth/login`
  - Static serving via `middleware.AdminStatic()`
- `ADM` prefix for business ID generation
- Admin accounts are **manual-only** — no API endpoint for creating/modifying/deleting admin records

### Changed

- `router.Setup` signature now accepts `adminDist string` for admin SPA serving
- `main.go` includes `buildAdmin()` — auto-builds AAAADMIN from `../AAAADMIN/` on startup
- `middleware` package includes `AdminStatic()` handler for serving admin frontend
- Database schema upgraded to v1.1.5 (8 tables)

---

## v1.0.0 (2026-06-26)

### Features

- REST API with Fiber v2 framework (v2.52.13)
- JWT authentication (HS256, 24h expiry) with `user_id`, `project_id`, `role` claims
- API Key authentication for edge devices (`X-API-Key` header); public when not configured
- Multi-tenant architecture — all data scoped by `project_id` from JWT
- CRUD endpoints: Projects, Houses, Users, Vehicles, Devices
- Access Logs: create and read-only query
- Blacklist management with license plate check endpoint
- Edge-to-cloud synchronization:
  - `GET /edge/sync/pull` — pull authorized data for offline cache
  - `POST /edge/sync/push` — push batched logs in a single DB transaction
  - `GET /edge/validate/:plate` — real-time plate validation (GRANTED/DENIED/UNKNOWN)
  - `GET /edge/check/:plate` — quick blacklist lookup
- Soft-delete on all resources (`is_active=0`)
- CORS (all origins), request logging, panic recovery middleware
- Custom 404 handler with JSON error response
- Unit tests for all handlers and middleware (`sqlmock` + `testify`)
- Microsoft SQL Server backend with `sqlx` (connection pool: 25 max open)
- Configurable via environment variables (`.env` or system env)
- Business ID generation: `{PREFIX}-YYYYMMDDHHmmss`
- All tables use `update_date` auto-update triggers in SQL Server
