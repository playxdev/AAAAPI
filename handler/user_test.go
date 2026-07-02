package handler

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
)

func TestUserHandler_List(t *testing.T) {
	db, mock := newMockDB()
	h := NewUserHandler(db)

	t.Run("success no filters", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE is_active = 1 AND is_delete = 0 ORDER BY autoID DESC").
			WillReturnRows(sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "John Doe")...))

		app := setupTestApp("GET", "/users", h.List)
		req := httptest.NewRequest("GET", "/users", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("with project_id and house_id", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE is_active = 1 AND is_delete = 0 AND project_id = @p1 AND house_id = @p2 ORDER BY autoID DESC").
			WithArgs("PRJ-001", "HSE-001").
			WillReturnRows(sqlmock.NewRows(userColumns))

		app := setupTestApp("GET", "/users", h.List)
		req := httptest.NewRequest("GET", "/users?project_id=PRJ-001&house_id=HSE-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_user").WillReturnError(errors.New("db error"))
		app := setupTestApp("GET", "/users", h.List)
		req := httptest.NewRequest("GET", "/users", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 500, resp.StatusCode)
	})
}

func TestUserHandler_Get(t *testing.T) {
	db, mock := newMockDB()
	h := NewUserHandler(db)

	t.Run("found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE user_id = @p1").
			WithArgs("USR-001").
			WillReturnRows(sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "John")...))

		app := setupTestApp("GET", "/users/:id", h.Get)
		req := httptest.NewRequest("GET", "/users/USR-001", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 200, resp.StatusCode)
	})

	t.Run("not found", func(t *testing.T) {
		mock.ExpectQuery("SELECT \\* FROM tb_user").WillReturnError(errors.New("sql: no rows"))
		app := setupTestApp("GET", "/users/:id", h.Get)
		req := httptest.NewRequest("GET", "/users/USR-999", nil)
		resp, _ := app.Test(req)
		assert.Equal(t, 404, resp.StatusCode)
	})
}

func TestUserHandler_Create(t *testing.T) {
	db, mock := newMockDB()
	h := NewUserHandler(db)

	t.Run("success", func(t *testing.T) {
		mock.ExpectExec("INSERT INTO tb_user").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE user_id").WillReturnRows(
			sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "John")...))

		body := `{"project_id":"PRJ-001","full_name":"John"}`
		app := setupTestApp("POST", "/users", h.Create)
		req := httptest.NewRequest("POST", "/users", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 201, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		app := setupTestApp("POST", "/users", h.Create)
		req := httptest.NewRequest("POST", "/users", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("default role", func(t *testing.T) {
		mock.ExpectExec("INSERT INTO tb_user").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE user_id").WillReturnRows(
			sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "John")...))

		body := `{"project_id":"PRJ-001","full_name":"John"}`
		app := setupTestApp("POST", "/users", h.Create)
		req := httptest.NewRequest("POST", "/users", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)
		assert.Equal(t, 201, resp.StatusCode)
	})
}

func TestUserHandler_Update(t *testing.T) {
	db, mock := newMockDB()
	h := NewUserHandler(db)

	mock.ExpectExec("UPDATE tb_user SET").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT \\* FROM tb_user WHERE user_id = @p1").
		WithArgs("USR-001").
		WillReturnRows(sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "Jane")...))

	body := `{"full_name":"Jane"}`
	app := setupTestApp("PUT", "/users/:id", h.Update)
	req := httptest.NewRequest("PUT", "/users/USR-001", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}

func TestUserHandler_Delete(t *testing.T) {
	db, mock := newMockDB()
	h := NewUserHandler(db)

	mock.ExpectExec("UPDATE tb_user SET is_active = 0").WithArgs("System", "USR-001").WillReturnResult(sqlmock.NewResult(0, 1))

	app := setupTestApp("DELETE", "/users/:id", h.Delete)
	req := httptest.NewRequest("DELETE", "/users/USR-001", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}
