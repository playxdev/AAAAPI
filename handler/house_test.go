package handler

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
)

func TestHouseHandler_List(t *testing.T) {
	db, mock := newMockDB()
	h := NewHouseHandler(db)

	t.Run("success no filters", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_house WHERE is_active = 1 AND is_delete = 0 ORDER BY autoID DESC").
			WillReturnRows(sqlmock.NewRows(houseColumns).AddRow(houseRow(1, "HSE-001", "PRJ-001", "1/1")...))

		app := setupTestApp("GET", "/houses", h.List)
		req := httptest.NewRequest("GET", "/houses", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("with project_id filter", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_house WHERE is_active = 1 AND is_delete = 0 AND project_id = @p1 ORDER BY autoID DESC").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(houseColumns))

		app := setupTestApp("GET", "/houses", h.List)
		req := httptest.NewRequest("GET", "/houses?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_house").WillReturnError(errors.New("db error"))
		app := setupTestApp("GET", "/houses", h.List)
		req := httptest.NewRequest("GET", "/houses", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestHouseHandler_Get(t *testing.T) {
	db, mock := newMockDB()
	h := NewHouseHandler(db)

	t.Run("found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_house WHERE house_id = @p1").
			WithArgs("HSE-001").
			WillReturnRows(sqlmock.NewRows(houseColumns).AddRow(houseRow(1, "HSE-001", "PRJ-001", "1/1")...))

		app := setupTestApp("GET", "/houses/:id", h.Get)
		req := httptest.NewRequest("GET", "/houses/HSE-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("not found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_house").WillReturnError(errors.New("sql: no rows"))
		app := setupTestApp("GET", "/houses/:id", h.Get)
		req := httptest.NewRequest("GET", "/houses/HSE-999", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 404, resp.StatusCode)
	})
}

func TestHouseHandler_Create(t *testing.T) {
	db, mock := newMockDB()
	h := NewHouseHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectExec("INSERT INTO tb_house").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectQuery("SELECT \\* FROM tb_house WHERE house_id").WillReturnRows(
			sqlmock.NewRows(houseColumns).AddRow(houseRow(1, "HSE-001", "PRJ-001", "1/1")...))

		body := `{"project_id":"PRJ-001","house_number":"1/1"}`
		app := setupTestApp("POST", "/houses", h.Create)
		req := httptest.NewRequest("POST", "/houses", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 201, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		app := setupTestApp("POST", "/houses", h.Create)
		req := httptest.NewRequest("POST", "/houses", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})
}

func TestHouseHandler_Update(t *testing.T) {
	db, mock := newMockDB()
	h := NewHouseHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectExec("UPDATE tb_house SET").WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectQuery("SELECT \\* FROM tb_house WHERE house_id = @p1").
			WithArgs("HSE-001").
			WillReturnRows(sqlmock.NewRows(houseColumns).AddRow(houseRow(1, "HSE-001", "PRJ-001", "2/2")...))

		body := `{"house_number":"2/2","project_id":"PRJ-001"}`
		app := setupTestApp("PUT", "/houses/:id", h.Update)
		req := httptest.NewRequest("PUT", "/houses/HSE-001", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		app := setupTestApp("PUT", "/houses/:id", h.Update)
		req := httptest.NewRequest("PUT", "/houses/HSE-001", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})
}

func TestHouseHandler_Delete(t *testing.T) {
	db, mock := newMockDB()
	h := NewHouseHandler(db)

	mock.ExpectExec("UPDATE tb_house SET is_active = 0").WithArgs("System", "HSE-001").WillReturnResult(sqlmock.NewResult(0, 1))

	app := setupTestApp("DELETE", "/houses/:id", h.Delete)
	req := httptest.NewRequest("DELETE", "/houses/HSE-001", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}
