# Contributing to AAAAPI

## Prerequisites

- **Go** 1.23+
- **Node.js** + npm (for AAAADMIN admin frontend)
- **Microsoft SQL Server** instance (local or remote)
- Database schema applied: run [`AAASQL/docs/AAA.sql`](../AAASQL/docs/AAA.sql) (v1.1.5)

## Getting Started

```bash
cd AAAAPI
cp .env.example .env          # fill in DB credentials, JWT_SECRET, optional API_KEY
go mod download                # install dependencies
go run main.go                 # auto-builds AAAADMIN, starts on FIBER_PORT
```

## Development

### Project Layout

| Package      | Purpose                                     |
|------------- |-------------------------------------------- |
| `config`     | Reads environment variables via `godotenv`   |
| `database`   | Manages `*sqlx.DB` singleton (25 open / 10 idle conns) |
| `model`      | Struct definitions, request/response DTOs    |
| `handler`    | HTTP handler structs (one per resource)      |
| `middleware` | CORS, logger, panic recover, JWT + API Key auth, AdminStatic, 404 |
| `router`     | Registers API routes + admin SPA serving     |

### Sibling Directories

| Directory    | Purpose                                     |
|------------- |-------------------------------------------- |
| `../AAASQL/` | MSSQL schema scripts, docs, standards        |
| `../AAAADMIN/` | TypeScript admin SPA (Vue/Vite). Built by `main.go` at startup and served at `/`. |

### Adding a New Resource

1. **Model** — Add struct + DTOs in `model/model.go`
2. **Handler** — Create `handler/<resource>.go`:
   ```go
   type FooHandler struct{ DB *sqlx.DB }
   func NewFooHandler(db *sqlx.DB) *FooHandler { return &FooHandler{DB: db} }
   func (h *FooHandler) List(c *fiber.Ctx) error { ... }
   func (h *FooHandler) Get(c *fiber.Ctx) error { ... }
   func (h *FooHandler) Create(c *fiber.Ctx) error { ... }
   func (h *FooHandler) Update(c *fiber.Ctx) error { ... }
   func (h *FooHandler) Delete(c *fiber.Ctx) error { ... }
   ```
3. **Router** — Register in `router/router.go` under the JWT-protected group
4. **Tests** — Add `handler/<resource>_test.go` using `sqlmock` + `testify`

### Authentication

- **JWT (mobile/web):** Extract user context via `c.Locals("user_id")`, `c.Locals("project_id")`, `c.Locals("role")`. All CRUD queries must filter by `project_id`.
- **API Key (edge devices):** Edge routes use `middleware.EdgeAuth(apiKey)`. When `API_KEY` env is empty, edge routes are public — useful for development.
- **Admin:** Admin accounts are stored in `tb_admin` with bcrypt-hashed passwords. **No API endpoint exists for creating or managing admin accounts** — they must be created manually via SQL. See `AAASQL/README.md` for instructions.

### Multi-Tenancy

Every data query must include `project_id` from the JWT claim. Always apply soft-delete filters:

```sql
WHERE project_id = @p1 AND is_active = 1 AND is_delete = 0
```

### Edge Push Format

`POST /api/v1/edge/sync/push` expects `device_id` at the **top level** of the request body, not per log entry. All logs in a batch share the same device:

```json
{
  "project_id": "PRJ-...",
  "device_id": "DEV-...",
  "logs": [
    {"license_plate": "...", "access_type": "LPR", "user_type": "RESIDENT", "is_success": true},
    {"license_plate": "...", "access_type": "LPR", "user_type": "VISITOR", "is_success": false}
  ]
}
```

Log entries are inserted within a single database transaction — any failure rolls back the entire batch.

### Business ID Generation

IDs use the format `{PREFIX}-YYYYMMDDHHmmss` (e.g., `PRJ-20260628120000`). Prefixes:

| Prefix | Table / Entity |
|------- |--------------- |
| `PRJ`  | Project        |
| `HSE`  | House          |
| `USR`  | User           |
| `VEH`  | Vehicle        |
| `DEV`  | Device         |
| `ACL`  | Access Log     |
| `BLK`  | Blacklist      |
| `ADM`  | Admin          |

Edge-pushed log IDs append a sequence counter: `ACL-YYYYMMDDHHmmss-0`, `ACL-YYYYMMDDHHmmss-1`, etc.

## Code Style

- `gofmt` / `goimports` for formatting
- Table-driven tests with `testify/assert`
- JSON struct tags on all request/response types
- Named parameters (`@p1`, `@p2`) with `sqlx`
- No hard-deletes — use `is_active=0` for all deletes

## Testing

```bash
go test ./...              # run all tests
go test ./... -v           # verbose
go test ./... -cover       # with coverage report
go test ./... -count=1     # disable cache
```

Tests use `go-sqlmock` — no database connection required. Each handler test covers list, get, create, update, and delete with both success and error paths.

## Commit Messages

Use conventional commits:

```
feat: add access log export endpoint
fix: handle null contact_number in project update
docs: add edge push request example
test: add blacklist check test cases
refactor: extract common query filter helper
```
