package middleware

import (
	"aaaapi/handler"
	"aaaapi/model"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

func EdgeAuth(apiKey string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if apiKey == "" {
			return c.Next()
		}
		key := c.Get("X-API-Key")
		if key == "" {
			return c.Status(401).JSON(model.ErrorResponse{Error: "x-api-key header required"})
		}
		if key != apiKey {
			return c.Status(401).JSON(model.ErrorResponse{Error: "invalid api key"})
		}
		return c.Next()
	}
}

func JWTAuth(secret []byte) fiber.Handler {
	return func(c *fiber.Ctx) error {
		header := c.Get("Authorization")
		if header == "" {
			return c.Status(401).JSON(model.ErrorResponse{Error: "authorization header required"})
		}

		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			return c.Status(401).JSON(model.ErrorResponse{Error: "invalid authorization format"})
		}

		claims := &handler.JWTClaims{}
		token, err := jwt.ParseWithClaims(parts[1], claims, func(t *jwt.Token) (interface{}, error) {
			return secret, nil
		})
		if err != nil || !token.Valid {
			return c.Status(401).JSON(model.ErrorResponse{Error: "invalid or expired token"})
		}

		c.Locals("user_id", claims.UserID)
		c.Locals("project_id", claims.ProjectID)
		c.Locals("role", claims.Role)

		return c.Next()
	}
}
