package handler

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
)

func TestDeviceHandler_List(t *testing.T) {
	db, mock := newMockDB()
	h := NewDeviceHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_device WHERE is_active = 1 AND is_delete = 0 ORDER BY autoID DESC").
			WillReturnRows(sqlmock.NewRows(deviceColumns).AddRow(deviceRow(1, "DEV-001", "PRJ-001", "Main Gate")...))

		app := setupTestApp("GET", "/devices", h.List)
		req := httptest.NewRequest("GET", "/devices", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_device").WillReturnError(errors.New("db error"))
		app := setupTestApp("GET", "/devices", h.List)
		req := httptest.NewRequest("GET", "/devices", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestDeviceHandler_Get(t *testing.T) {
	db, mock := newMockDB()
	h := NewDeviceHandler(db)

	t.Run("found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_device WHERE device_id = @p1").
			WithArgs("DEV-001").
			WillReturnRows(sqlmock.NewRows(deviceColumns).AddRow(deviceRow(1, "DEV-001", "PRJ-001", "Main Gate")...))

		app := setupTestApp("GET", "/devices/:id", h.Get)
		req := httptest.NewRequest("GET", "/devices/DEV-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("not found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_device").WillReturnError(errors.New("sql: no rows"))
		app := setupTestApp("GET", "/devices/:id", h.Get)
		req := httptest.NewRequest("GET", "/devices/DEV-999", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 404, resp.StatusCode)
	})
}

func TestDeviceHandler_Create(t *testing.T) {
	db, mock := newMockDB()
	h := NewDeviceHandler(db)

	mock.ExpectExec("INSERT INTO tb_device").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery("SELECT \\* FROM tb_device WHERE device_id").WillReturnRows(
		sqlmock.NewRows(deviceColumns).AddRow(deviceRow(1, "DEV-001", "PRJ-001", "Main Gate")...))

	body := `{"project_id":"PRJ-001","gate_name":"Main Gate"}`
	app := setupTestApp("POST", "/devices", h.Create)
	req := httptest.NewRequest("POST", "/devices", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	assert.Equal(t, 201, resp.StatusCode)
}

func TestDeviceHandler_Update(t *testing.T) {
	db, mock := newMockDB()
	h := NewDeviceHandler(db)

	mock.ExpectExec("UPDATE tb_device SET").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT \\* FROM tb_device WHERE device_id = @p1").
		WithArgs("DEV-001").
		WillReturnRows(sqlmock.NewRows(deviceColumns).AddRow(deviceRow(1, "DEV-001", "PRJ-001", "Side Gate")...))

	body := `{"gate_name":"Side Gate"}`
	app := setupTestApp("PUT", "/devices/:id", h.Update)
	req := httptest.NewRequest("PUT", "/devices/DEV-001", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}

func TestDeviceHandler_Delete(t *testing.T) {
	db, mock := newMockDB()
	h := NewDeviceHandler(db)

	mock.ExpectExec("UPDATE tb_device SET is_active = 0").WithArgs("System", "DEV-001").WillReturnResult(sqlmock.NewResult(0, 1))

	app := setupTestApp("DELETE", "/devices/:id", h.Delete)
	req := httptest.NewRequest("DELETE", "/devices/DEV-001", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}
