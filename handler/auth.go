package handler

import (
	"aaaapi/model"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jmoiron/sqlx"
	"golang.org/x/crypto/bcrypt"
)

type AuthHandler struct {
	db        *sqlx.DB
	jwtSecret []byte
}

type JWTClaims struct {
	UserID    string `json:"user_id"`
	ProjectID string `json:"project_id"`
	Role      string `json:"role"`
	jwt.RegisteredClaims
}

func NewAuthHandler(db *sqlx.DB, secret string) *AuthHandler {
	return &AuthHandler{db: db, jwtSecret: []byte(secret)}
}

func (h *AuthHandler) AdminLogin(c *fiber.Ctx) error {
	var req model.AdminLoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	if req.AdminName == "" || req.Password == "" {
		return c.Status(400).JSON(model.ErrorResponse{Error: "admin_name and password are required"})
	}

	var admin model.Admin
	err := h.db.Get(&admin,
		"SELECT * FROM tb_admin WHERE admin_name = @p1 AND is_active = 1 AND is_delete = 0",
		req.AdminName,
	)
	if err != nil {
		return c.Status(401).JSON(model.ErrorResponse{Error: "invalid credentials"})
	}

	if bcrypt.CompareHashAndPassword([]byte(admin.AdminPassword), []byte(req.Password)) != nil {
		return c.Status(401).JSON(model.ErrorResponse{Error: "invalid credentials"})
	}

	claims := JWTClaims{
		UserID:    admin.AdminID,
		ProjectID: admin.ProjectID,
		Role:      admin.AdminLevel,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signedToken, err := token.SignedString(h.jwtSecret)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: "failed to generate token"})
	}

	return c.JSON(model.AdminLoginResponse{
		Token:    signedToken,
		AdminID:  admin.AdminID,
		FullName: admin.AdminName,
		Role:     admin.AdminLevel,
	})
}

func (h *AuthHandler) Login(c *fiber.Ctx) error {
	var req model.LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	if req.UserID == "" || req.PhoneNumber == "" {
		return c.Status(400).JSON(model.ErrorResponse{Error: "user_id and phone_number are required"})
	}

	var user model.User
	err := h.db.Get(&user,
		"SELECT * FROM tb_user WHERE user_id = @p1 AND phone_number = @p2 AND is_active = 1 AND is_delete = 0",
		req.UserID, req.PhoneNumber,
	)
	if err != nil {
		return c.Status(401).JSON(model.ErrorResponse{Error: "invalid credentials"})
	}

	claims := JWTClaims{
		UserID:    user.UserID,
		ProjectID: user.ProjectID,
		Role:      user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signedToken, err := token.SignedString(h.jwtSecret)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: "failed to generate token"})
	}

	return c.JSON(model.LoginResponse{
		Token:    signedToken,
		UserID:   user.UserID,
		FullName: user.FullName,
		Role:     user.Role,
	})
}
