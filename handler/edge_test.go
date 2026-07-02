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

func TestEdgeHandler_PullData(t *testing.T) {
	db, mock := newMockDB()
	h := NewEdgeHandler(db)

	t.Run("success with data", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE project_id = @p1").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(vehicleColumns).AddRow(vehicleRow(1, "VEH-001", "PRJ-001", "USR-001", "กข1234")...))
		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE project_id = @p1").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "John")...))
		mock.ExpectQuery("SELECT \\* FROM tb_device WHERE project_id = @p1").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(deviceColumns).AddRow(deviceRow(1, "DEV-001", "PRJ-001", "Main Gate")...))
		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE project_id = @p1").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(blacklistColumns))

		app := setupTestApp("GET", "/edge/sync/pull", h.PullData)
		req := httptest.NewRequest("GET", "/edge/sync/pull?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		assert.Equal(t, "PRJ-001", body["project_id"])
		assert.NotNil(t, body["data"])
	})

	t.Run("missing project_id", func(t *testing.T) {
		app := setupTestApp("GET", "/edge/sync/pull", h.PullData)
		req := httptest.NewRequest("GET", "/edge/sync/pull", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("db error on vehicles", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE project_id = @p1").
			WithArgs("PRJ-001").
			WillReturnError(errors.New("db error"))

		app := setupTestApp("GET", "/edge/sync/pull", h.PullData)
		req := httptest.NewRequest("GET", "/edge/sync/pull?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestEdgeHandler_Validate(t *testing.T) {
	t.Run("blacklisted plate", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewEdgeHandler(db)

		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE license_plate = @p1 AND project_id = @p2").
			WithArgs("กข1234", "PRJ-001").
			WillReturnRows(sqlmock.NewRows(blacklistColumns).AddRow(blacklistRow(1, "BLK-001", "PRJ-001", "กข1234")...))

		app := setupTestApp("GET", "/edge/validate/:plate", h.Validate)
		req := httptest.NewRequest("GET", "/edge/validate/กข1234?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		assert.Equal(t, false, body["allowed"])
		assert.Equal(t, "DENIED", body["access_type"])
	})

	t.Run("registered vehicle", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewEdgeHandler(db)

		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE license_plate = @p1 AND project_id = @p2").
			WithArgs("กข1234", "PRJ-001").
			WillReturnError(errors.New("sql: no rows"))
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE license_plate = @p1 AND project_id = @p2").
			WithArgs("กข1234", "PRJ-001").
			WillReturnRows(sqlmock.NewRows(vehicleColumns).AddRow(vehicleRow(1, "VEH-001", "PRJ-001", "USR-001", "กข1234")...))
		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE user_id = @p1").
			WithArgs("USR-001").
			WillReturnRows(sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "John Doe")...))
		mock.ExpectQuery("SELECT \\* FROM tb_house WHERE house_id = @p1").
			WillReturnError(errors.New("sql: no rows"))

		app := setupTestApp("GET", "/edge/validate/:plate", h.Validate)
		req := httptest.NewRequest("GET", "/edge/validate/กข1234?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		assert.Equal(t, true, body["allowed"])
		assert.Equal(t, "GRANTED", body["access_type"])
		assert.Equal(t, "USR-001", body["user_id"])
	})

	t.Run("unknown plate", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewEdgeHandler(db)

		mock.ExpectQuery("SELECT \\* FROM tb_blacklist WHERE license_plate = @p1 AND project_id = @p2").
			WithArgs("unknown", "PRJ-001").
			WillReturnError(errors.New("sql: no rows"))
		mock.ExpectQuery("SELECT \\* FROM tb_vehicle WHERE license_plate = @p1 AND project_id = @p2").
			WithArgs("unknown", "PRJ-001").
			WillReturnError(errors.New("sql: no rows"))

		app := setupTestApp("GET", "/edge/validate/:plate", h.Validate)
		req := httptest.NewRequest("GET", "/edge/validate/unknown?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
		var body map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&body)
		assert.Equal(t, false, body["allowed"])
		assert.Equal(t, "UNKNOWN", body["access_type"])
	})

	t.Run("missing params", func(t *testing.T) {
		db, _ := newMockDB()
		h := NewEdgeHandler(db)

		app := setupTestApp("GET", "/edge/validate/:plate", h.Validate)
		req := httptest.NewRequest("GET", "/edge/validate/กข1234", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})
}

func TestEdgeHandler_PushLogs(t *testing.T) {
	t.Run("success batch 2 logs", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewEdgeHandler(db)

		mock.ExpectBegin()
		mock.ExpectExec("INSERT INTO tb_access_log").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectExec("INSERT INTO tb_access_log").WillReturnResult(sqlmock.NewResult(2, 1))
		mock.ExpectCommit()

		body := `{"project_id":"PRJ-001","device_id":"DEV-001","logs":[{"license_plate":"กข1234","access_type":"ENTRY","user_type":"RESIDENT","is_success":true},{"license_plate":"งจ5678","access_type":"EXIT","user_type":"VISITOR","is_success":true}]}`
		app := setupTestApp("POST", "/edge/sync/push", h.PushLogs)
		req := httptest.NewRequest("POST", "/edge/sync/push", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 201, resp.StatusCode)
	})

	t.Run("missing project_id", func(t *testing.T) {
		db, _ := newMockDB()
		h := NewEdgeHandler(db)

		body := `{"logs":[{"license_plate":"กข1234"}]}`
		app := setupTestApp("POST", "/edge/sync/push", h.PushLogs)
		req := httptest.NewRequest("POST", "/edge/sync/push", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("empty logs", func(t *testing.T) {
		db, _ := newMockDB()
		h := NewEdgeHandler(db)

		body := `{"project_id":"PRJ-001","logs":[]}`
		app := setupTestApp("POST", "/edge/sync/push", h.PushLogs)
		req := httptest.NewRequest("POST", "/edge/sync/push", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		db, _ := newMockDB()
		h := NewEdgeHandler(db)

		app := setupTestApp("POST", "/edge/sync/push", h.PushLogs)
		req := httptest.NewRequest("POST", "/edge/sync/push", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("tx begin error", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewEdgeHandler(db)

		mock.ExpectBegin().WillReturnError(errors.New("tx error"))

		body := `{"project_id":"PRJ-001","logs":[{"license_plate":"กข1234","is_success":true}]}`
		app := setupTestApp("POST", "/edge/sync/push", h.PushLogs)
		req := httptest.NewRequest("POST", "/edge/sync/push", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})

	t.Run("commit error", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewEdgeHandler(db)

		mock.ExpectBegin()
		mock.ExpectExec("INSERT INTO tb_access_log").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectCommit().WillReturnError(errors.New("commit error"))

		body := `{"project_id":"PRJ-001","logs":[{"license_plate":"กข1234","is_success":true}]}`
		app := setupTestApp("POST", "/edge/sync/push", h.PushLogs)
		req := httptest.NewRequest("POST", "/edge/sync/push", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})
}
