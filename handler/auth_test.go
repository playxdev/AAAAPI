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

func TestAuthHandler_Login(t *testing.T) {
	jwtSecret := "test-secret-key"

	t.Run("success", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewAuthHandler(db, jwtSecret)

		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE user_id = @p1 AND phone_number = @p2").
			WithArgs("USR-001", "0812345678").
			WillReturnRows(sqlmock.NewRows(userColumns).AddRow(userRow(1, "USR-001", "PRJ-001", "John Doe")...))

		body := `{"user_id":"USR-001","phone_number":"0812345678"}`
		app := setupTestApp("POST", "/auth/login", h.Login)
		req := httptest.NewRequest("POST", "/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 200, resp.StatusCode)

		var result map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&result)
		assert.NotEmpty(t, result["token"])
		assert.Equal(t, "USR-001", result["user_id"])
		assert.Equal(t, "John Doe", result["full_name"])
	})

	t.Run("invalid credentials", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewAuthHandler(db, jwtSecret)

		mock.ExpectQuery("SELECT \\* FROM tb_user WHERE user_id = @p1 AND phone_number = @p2").
			WithArgs("USR-999", "0000000000").
			WillReturnError(errors.New("sql: no rows"))

		body := `{"user_id":"USR-999","phone_number":"0000000000"}`
		app := setupTestApp("POST", "/auth/login", h.Login)
		req := httptest.NewRequest("POST", "/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 401, resp.StatusCode)
	})

	t.Run("missing fields", func(t *testing.T) {
		db, _ := newMockDB()
		h := NewAuthHandler(db, jwtSecret)

		body := `{"user_id":"USR-001"}`
		app := setupTestApp("POST", "/auth/login", h.Login)
		req := httptest.NewRequest("POST", "/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("invalid body", func(t *testing.T) {
		db, _ := newMockDB()
		h := NewAuthHandler(db, jwtSecret)

		app := setupTestApp("POST", "/auth/login", h.Login)
		req := httptest.NewRequest("POST", "/auth/login", strings.NewReader("invalid"))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 400, resp.StatusCode)
	})

	t.Run("db error", func(t *testing.T) {
		db, mock := newMockDB()
		h := NewAuthHandler(db, jwtSecret)

		mock.ExpectQuery("SELECT \\* FROM tb_user").
			WithArgs("USR-001", "0812345678").
			WillReturnError(errors.New("connection refused"))

		body := `{"user_id":"USR-001","phone_number":"0812345678"}`
		app := setupTestApp("POST", "/auth/login", h.Login)
		req := httptest.NewRequest("POST", "/auth/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, _ := app.Test(req)

		assert.Equal(t, 401, resp.StatusCode)
	})
}
