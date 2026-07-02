package handler

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
)

func TestAccessLogHandler_List(t *testing.T) {
	db, mock := newMockDB()
	h := NewAccessLogHandler(db)

	t.Run("success no filters", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_access_log WHERE is_active = 1 AND is_delete = 0 ORDER BY access_date DESC").
			WillReturnRows(sqlmock.NewRows(accessLogColumns).AddRow(accessLogRow(1, "ACL-001", "PRJ-001", "กข1234")...))

		app := setupTestApp("GET", "/access-logs", h.List)
		req := httptest.NewRequest("GET", "/access-logs", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("with filters", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_access_log WHERE is_active = 1 AND is_delete = 0 AND project_id = @p1 AND license_plate LIKE @p2 ORDER BY access_date DESC").
			WithArgs("PRJ-001", "%กข%").
			WillReturnRows(sqlmock.NewRows(accessLogColumns))

		app := setupTestApp("GET", "/access-logs", h.List)
		req := httptest.NewRequest("GET", "/access-logs?project_id=PRJ-001&license_plate=กข", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("with date range", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_access_log WHERE is_active = 1 AND is_delete = 0 AND access_date >= @p1 AND access_date <= @p2 ORDER BY access_date DESC").
			WithArgs("2026-01-01", "2026-12-31").
			WillReturnRows(sqlmock.NewRows(accessLogColumns))

		app := setupTestApp("GET", "/access-logs", h.List)
		req := httptest.NewRequest("GET", "/access-logs?date_from=2026-01-01&date_to=2026-12-31", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_access_log").WillReturnError(errors.New("db error"))
		app := setupTestApp("GET", "/access-logs", h.List)
		req := httptest.NewRequest("GET", "/access-logs", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestAccessLogHandler_Get(t *testing.T) {
	db, mock := newMockDB()
	h := NewAccessLogHandler(db)

	t.Run("found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_access_log WHERE log_id = @p1").
			WithArgs("ACL-001").
			WillReturnRows(sqlmock.NewRows(accessLogColumns).AddRow(accessLogRow(1, "ACL-001", "PRJ-001", "กข1234")...))

		app := setupTestApp("GET", "/access-logs/:id", h.Get)
		req := httptest.NewRequest("GET", "/access-logs/ACL-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("not found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_access_log").WillReturnError(errors.New("sql: no rows"))
		app := setupTestApp("GET", "/access-logs/:id", h.Get)
		req := httptest.NewRequest("GET", "/access-logs/ACL-999", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 404, resp.StatusCode)
	})
}

func TestAccessLogHandler_Create(t *testing.T) {
	db, mock := newMockDB()
	h := NewAccessLogHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectExec("INSERT INTO tb_access_log").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectQuery("SELECT \\* FROM tb_access_log WHERE log_id").WillReturnRows(
			sqlmock.NewRows(accessLogColumns).AddRow(accessLogRow(1, "ACL-001", "PRJ-001", "กข1234")...))

		body := `{"project_id":"PRJ-001","license_plate":"กข1234","access_type":"ENTRY","user_type":"RESIDENT","is_success":true}`
		app := setupTestApp("POST", "/access-logs", h.Create)
		req := httptest.NewRequest("POST", "/access-logs", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 201, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		app := setupTestApp("POST", "/access-logs", h.Create)
		req := httptest.NewRequest("POST", "/access-logs", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})
}
