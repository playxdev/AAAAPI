package middleware

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"

	"aaaapi/handler"
)

var testSecret = []byte("test-secret-key")

func generateTestToken(userID, projectID, role string) string {
	claims := handler.JWTClaims{
		UserID:    userID,
		ProjectID: projectID,
		Role:      role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, _ := token.SignedString(testSecret)
	return s
}

func TestEdgeAuth_NoKey(t *testing.T) {
	app := fiber.New()
	app.Use(EdgeAuth(""))
	app.Get("/edge", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/edge", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)
}

func TestEdgeAuth_ValidKey(t *testing.T) {
	app := fiber.New()
	app.Use(EdgeAuth("secret-key"))
	app.Get("/edge", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/edge", nil)
	req.Header.Set("X-API-Key", "secret-key")
	resp, _ := app.Test(req)
	assert.Equal(t, 200, resp.StatusCode)

	req2 := httptest.NewRequest("GET", "/edge", nil)
	req2.Header.Set("X-API-Key", "secret-key")
	resp2, _ := app.Test(req2)
	assert.Equal(t, 200, resp2.StatusCode)
}

func TestEdgeAuth_MissingKey(t *testing.T) {
	app := fiber.New()
	app.Use(EdgeAuth("secret-key"))
	app.Get("/edge", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/edge", nil)
	resp, _ := app.Test(req)
	assert.Equal(t, 401, resp.StatusCode)
}

func TestEdgeAuth_InvalidKey(t *testing.T) {
	app := fiber.New()
	app.Use(EdgeAuth("secret-key"))
	app.Get("/edge", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/edge", nil)
	req.Header.Set("X-API-Key", "wrong-key")
	resp, _ := app.Test(req)
	assert.Equal(t, 401, resp.StatusCode)
}

func TestJWTAuth_Success(t *testing.T) {
	app := fiber.New()
	app.Use(JWTAuth(testSecret))
	app.Get("/protected", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"user_id":    c.Locals("user_id"),
			"project_id": c.Locals("project_id"),
			"role":       c.Locals("role"),
		})
	})

	token := generateTestToken("USR-001", "PRJ-001", "RESIDENT")

	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, _ := app.Test(req)

	assert.Equal(t, 200, resp.StatusCode)
}

func TestJWTAuth_MissingHeader(t *testing.T) {
	app := fiber.New()
	app.Use(JWTAuth(testSecret))
	app.Get("/protected", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/protected", nil)
	resp, _ := app.Test(req)

	assert.Equal(t, 401, resp.StatusCode)
}

func TestJWTAuth_InvalidFormat(t *testing.T) {
	app := fiber.New()
	app.Use(JWTAuth(testSecret))
	app.Get("/protected", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Basic abc123")
	resp, _ := app.Test(req)

	assert.Equal(t, 401, resp.StatusCode)
}

func TestJWTAuth_InvalidToken(t *testing.T) {
	app := fiber.New()
	app.Use(JWTAuth(testSecret))
	app.Get("/protected", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer invalid.token.here")
	resp, _ := app.Test(req)

	assert.Equal(t, 401, resp.StatusCode)
}

func TestJWTAuth_ExpiredToken(t *testing.T) {
	claims := handler.JWTClaims{
		UserID:    "USR-001",
		ProjectID: "PRJ-001",
		Role:      "RESIDENT",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-1 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, _ := token.SignedString(testSecret)

	app := fiber.New()
	app.Use(JWTAuth(testSecret))
	app.Get("/protected", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+s)
	resp, _ := app.Test(req)

	assert.Equal(t, 401, resp.StatusCode)
}

func TestJWTAuth_WrongSecret(t *testing.T) {
	app := fiber.New()
	app.Use(JWTAuth(testSecret))
	app.Get("/protected", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	claims := handler.JWTClaims{
		UserID:    "USR-001",
		ProjectID: "PRJ-001",
		Role:      "RESIDENT",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, _ := token.SignedString([]byte("wrong-secret"))

	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+s)
	resp, _ := app.Test(req)

	assert.Equal(t, 401, resp.StatusCode)
}
