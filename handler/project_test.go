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

func TestProjectHandler_List(t *testing.T) {
	db, mock := newMockDB()
	h := NewProjectHandler(db)

	t.Run("success no filters", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_project WHERE is_active = 1 AND is_delete = 0 ORDER BY autoID DESC").
			WillReturnRows(sqlmock.NewRows(projectColumns).AddRow(projectRow(1, "PRJ-001", "Test Project")...))

		app := setupTestApp("GET", "/projects", h.List)
		req := httptest.NewRequest("GET", "/projects", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("success with project_id filter", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_project WHERE is_active = 1 AND is_delete = 0 AND project_id = @p1 ORDER BY autoID DESC").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(projectColumns))

		app := setupTestApp("GET", "/projects", h.List)
		req := httptest.NewRequest("GET", "/projects?project_id=PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_project").
			WillReturnError(errors.New("db error"))

		app := setupTestApp("GET", "/projects", h.List)
		req := httptest.NewRequest("GET", "/projects", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestProjectHandler_Get(t *testing.T) {
	db, mock := newMockDB()
	h := NewProjectHandler(db)

	t.Run("found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_project WHERE project_id = @p1 AND is_active = 1 AND is_delete = 0").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(projectColumns).AddRow(projectRow(1, "PRJ-001", "Test")...))

		app := setupTestApp("GET", "/projects/:id", h.Get)
		req := httptest.NewRequest("GET", "/projects/PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("not found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_project").
			WithArgs("PRJ-999").
			WillReturnError(errors.New("sql: no rows"))

		app := setupTestApp("GET", "/projects/:id", h.Get)
		req := httptest.NewRequest("GET", "/projects/PRJ-999", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 404, resp.StatusCode)
	})
}

func TestProjectHandler_Create(t *testing.T) {
	db, mock := newMockDB()
	h := NewProjectHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectExec("INSERT INTO tb_project").
			WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectQuery("SELECT \\* FROM tb_project WHERE project_id").
			WillReturnRows(sqlmock.NewRows(projectColumns).AddRow(projectRow(1, "PRJ-001", "New Project")...))

		body := `{"project_name":"New Project","address":"123 Main St"}`
		app := setupTestApp("POST", "/projects", h.Create)
		req := httptest.NewRequest("POST", "/projects", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 201, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		app := setupTestApp("POST", "/projects", h.Create)
		req := httptest.NewRequest("POST", "/projects", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("db error on insert", func(t *testing.T) {
		mock.ExpectExec("INSERT INTO tb_project").
			WillReturnError(errors.New("db error"))

		body := `{"project_name":"Test"}`
		app := setupTestApp("POST", "/projects", h.Create)
		req := httptest.NewRequest("POST", "/projects", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestProjectHandler_Update(t *testing.T) {
	db, mock := newMockDB()
	h := NewProjectHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectExec("UPDATE tb_project SET").
			WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectQuery("SELECT \\* FROM tb_project WHERE project_id = @p1").
			WithArgs("PRJ-001").
			WillReturnRows(sqlmock.NewRows(projectColumns).AddRow(projectRow(1, "PRJ-001", "Updated")...))

		body := `{"project_name":"Updated"}`
		app := setupTestApp("PUT", "/projects/:id", h.Update)
		req := httptest.NewRequest("PUT", "/projects/PRJ-001", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		app := setupTestApp("PUT", "/projects/:id", h.Update)
		req := httptest.NewRequest("PUT", "/projects/PRJ-001", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 400, resp.StatusCode)
	})
}

func TestProjectHandler_Delete(t *testing.T) {
	db, mock := newMockDB()
	h := NewProjectHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectExec("UPDATE tb_project SET is_active = 0").
			WithArgs("System", "PRJ-001").
			WillReturnResult(sqlmock.NewResult(0, 1))

		app := setupTestApp("DELETE", "/projects/:id", h.Delete)
		req := httptest.NewRequest("DELETE", "/projects/PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		mock.ExpectExec("UPDATE tb_project SET is_active = 0").
			WillReturnError(errors.New("db error"))

		app := setupTestApp("DELETE", "/projects/:id", h.Delete)
		req := httptest.NewRequest("DELETE", "/projects/PRJ-001", nil)
		resp, _ := app.Test(req)

		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestProjectHandler_ResponseBody(t *testing.T) {
	db, mock := newMockDB()
	h := NewProjectHandler(db)

	mock.ExpectQuery("SELECT \\* FROM tb_project").
		WillReturnRows(sqlmock.NewRows(projectColumns).AddRow(projectRow(1, "PRJ-001", "My Project")...))

	app := setupTestApp("GET", "/projects", h.List)
	req := httptest.NewRequest("GET", "/projects", nil)
	resp, _ := app.Test(req)

	var body map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&body)
	assert.Equal(t, float64(1), body["total"])
	data := body["data"].([]interface{})
	assert.Equal(t, "My Project", data[0].(map[string]interface{})["project_name"])
}
