package handler

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
)

func TestBlacklistHandler_List(t *testing.T) {
	db, mock := newMockDB()
	h := NewBlacklistHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE is_active = 1 AND is_delete = 0 ORDER BY autoID DESC").
			WillReturnRows(sqlmock.NewRows(blacklistColumns).AddRow(blacklistRow(1, "BLK-001", "PRJ-001", "กข1234")...))

		app := setupTestApp("GET", "/blacklist", h.List)
		req := httptest.NewRequest("GET", "/blacklist", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("with license_plate filter", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE is_active = 1 AND is_delete = 0 AND license_plate LIKE @p1 ORDER BY autoID DESC").
			WithArgs("%กข%").
			WillReturnRows(sqlmock.NewRows(blacklistColumns))

		app := setupTestApp("GET", "/blacklist", h.List)
		req := httptest.NewRequest("GET", "/blacklist?license_plate=กข", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})
}

func TestBlacklistHandler_Get(t *testing.T) {
	db, mock := newMockDB()
	h := NewBlacklistHandler(db)

	t.Run("found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE blacklist_id = @p1").
			WithArgs("BLK-001").
			WillReturnRows(sqlmock.NewRows(blacklistColumns).AddRow(blacklistRow(1, "BLK-001", "PRJ-001", "กข1234")...))

		app := setupTestApp("GET", "/blacklist/:id", h.Get)
		req := httptest.NewRequest("GET", "/blacklist/BLK-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("not found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_blacklist").WillReturnError(errors.New("sql: no rows"))
		app := setupTestApp("GET", "/blacklist/:id", h.Get)
		req := httptest.NewRequest("GET", "/blacklist/BLK-999", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 404, resp.StatusCode)
	})
}

func TestBlacklistHandler_Check(t *testing.T) {
	db, mock := newMockDB()
	h := NewBlacklistHandler(db)

	t.Run("blacklisted", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE license_plate = @p1 AND project_id = @p2").
			WithArgs("กข1234", "PRJ-001").
			WillReturnRows(sqlmock.NewRows(blacklistColumns).AddRow(blacklistRow(1, "BLK-001", "PRJ-001", "กข1234")...))

		app := setupTestApp("GET", "/blacklist/check/:plate", h.Check)
		req := httptest.NewRequest("GET", "/blacklist/check/กข1234?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		assert.Equal(t, true, body["blacklisted"])
	})

	t.Run("not blacklisted", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE license_plate = @p1 AND project_id = @p2").
			WithArgs("งจ5678", "PRJ-001").
			WillReturnError(errors.New("sql: no rows"))

		app := setupTestApp("GET", "/blacklist/check/:plate", h.Check)
		req := httptest.NewRequest("GET", "/blacklist/check/งจ5678?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		assert.Equal(t, false, body["blacklisted"])
	})

	t.Run("missing project_id", func(t *testing.T) {
		app := setupTestApp("GET", "/blacklist/check/:plate", h.Check)
		req := httptest.NewRequest("GET", "/blacklist/check/กข1234", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})
}

func TestBlacklistHandler_Create(t *testing.T) {
	db, mock := newMockDB()
	h := NewBlacklistHandler(db)

	mock.ExpectExec("INSERT INTO tb_blacklist").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE blacklist_id").WillReturnRows(
		sqlmock.NewRows(blacklistColumns).AddRow(blacklistRow(1, "BLK-001", "PRJ-001", "กข1234")...))

	body := `{"project_id":"PRJ-001","license_plate":"กข1234","reason":"Suspicious"}`
	app := setupTestApp("POST", "/blacklist", h.Create)
	req := httptest.NewRequest("POST", "/blacklist", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	assert.Equal(t, 201, resp.StatusCode)
}

func TestBlacklistHandler_Update(t *testing.T) {
	db, mock := newMockDB()
	h := NewBlacklistHandler(db)

	mock.ExpectExec("UPDATE tb_blacklist SET").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE blacklist_id = @p1").
		WithArgs("BLK-001").
		WillReturnRows(sqlmock.NewRows(blacklistColumns).AddRow(blacklistRow(1, "BLK-001", "PRJ-001", "งจ5678")...))

	body := `{"license_plate":"งจ5678","reason":"Updated reason"}`
	app := setupTestApp("PUT", "/blacklist/:id", h.Update)
	req := httptest.NewRequest("PUT", "/blacklist/BLK-001", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}

func TestBlacklistHandler_Delete(t *testing.T) {
	db, mock := newMockDB()
	h := NewBlacklistHandler(db)

	mock.ExpectExec("UPDATE tb_blacklist SET is_active = 0").WithArgs("System", "BLK-001").WillReturnResult(sqlmock.NewResult(0, 1))

	app := setupTestApp("DELETE", "/blacklist/:id", h.Delete)
	req := httptest.NewRequest("DELETE", "/blacklist/BLK-001", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}
