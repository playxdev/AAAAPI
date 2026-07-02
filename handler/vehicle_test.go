package handler

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
)

func TestVehicleHandler_List(t *testing.T) {
	db, mock := newMockDB()
	h := NewVehicleHandler(db)

	t.Run("success no filters", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE is_active = 1 AND is_delete = 0 ORDER BY autoID DESC").
			WillReturnRows(sqlmock.NewRows(vehicleColumns).AddRow(vehicleRow(1, "VEH-001", "PRJ-001", "USR-001", "กข1234")...))

		app := setupTestApp("GET", "/vehicles", h.List)
		req := httptest.NewRequest("GET", "/vehicles", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("with license_plate filter", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE is_active = 1 AND is_delete = 0 AND license_plate LIKE @p1 ORDER BY autoID DESC").
			WithArgs("%กข%").
			WillReturnRows(sqlmock.NewRows(vehicleColumns))

		app := setupTestApp("GET", "/vehicles", h.List)
		req := httptest.NewRequest("GET", "/vehicles?license_plate=กข", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle").WillReturnError(errors.New("db error"))
		app := setupTestApp("GET", "/vehicles", h.List)
		req := httptest.NewRequest("GET", "/vehicles", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestVehicleHandler_Get(t *testing.T) {
	db, mock := newMockDB()
	h := NewVehicleHandler(db)

	t.Run("found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE vehicle_id = @p1").
			WithArgs("VEH-001").
			WillReturnRows(sqlmock.NewRows(vehicleColumns).AddRow(vehicleRow(1, "VEH-001", "PRJ-001", "USR-001", "กข1234")...))

		app := setupTestApp("GET", "/vehicles/:id", h.Get)
		req := httptest.NewRequest("GET", "/vehicles/VEH-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("not found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle").WillReturnError(errors.New("sql: no rows"))
		app := setupTestApp("GET", "/vehicles/:id", h.Get)
		req := httptest.NewRequest("GET", "/vehicles/VEH-999", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 404, resp.StatusCode)
	})
}

func TestVehicleHandler_Create(t *testing.T) {
	db, mock := newMockDB()
	h := NewVehicleHandler(db)

	mock.ExpectExec("INSERT INTO tb_vehicle").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE vehicle_id").WillReturnRows(
		sqlmock.NewRows(vehicleColumns).AddRow(vehicleRow(1, "VEH-001", "PRJ-001", "USR-001", "กข1234")...))

	body := `{"project_id":"PRJ-001","user_id":"USR-001","license_plate":"กข1234"}`
	app := setupTestApp("POST", "/vehicles", h.Create)
	req := httptest.NewRequest("POST", "/vehicles", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	assert.Equal(t, 201, resp.StatusCode)
}

func TestVehicleHandler_Update(t *testing.T) {
	db, mock := newMockDB()
	h := NewVehicleHandler(db)

	mock.ExpectExec("UPDATE tb_vehicle SET").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE vehicle_id = @p1").
		WithArgs("VEH-001").
		WillReturnRows(sqlmock.NewRows(vehicleColumns).AddRow(vehicleRow(1, "VEH-001", "PRJ-001", "USR-001", "งจ5678")...))

	body := `{"license_plate":"งจ5678"}`
	app := setupTestApp("PUT", "/vehicles/:id", h.Update)
	req := httptest.NewRequest("PUT", "/vehicles/VEH-001", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}

func TestVehicleHandler_Delete(t *testing.T) {
	db, mock := newMockDB()
	h := NewVehicleHandler(db)

	mock.ExpectExec("UPDATE tb_vehicle SET is_active = 0").WithArgs("System", "VEH-001").WillReturnResult(sqlmock.NewResult(0, 1))

	app := setupTestApp("DELETE", "/vehicles/:id", h.Delete)
	req := httptest.NewRequest("DELETE", "/vehicles/VEH-001", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}
