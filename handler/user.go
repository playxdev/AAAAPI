package handler

import (
	"aaaapi/model"
	"fmt"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type UserHandler struct {
	db *sqlx.DB
}

func NewUserHandler(db *sqlx.DB) *UserHandler {
	return &UserHandler{db: db}
}

func (h *UserHandler) List(c *fiber.Ctx) error {
	var users = make([]model.User, 0)
	query := "SELECT * FROM tb_user WHERE is_active = 1 AND is_delete = 0"
	args := []interface{}{}
	p := 1

	if pid := c.Query("project_id"); pid != "" {
		query += fmt.Sprintf(" AND project_id = @p%d", p)
		args = append(args, pid)
		p++
	}
	if hid := c.Query("house_id"); hid != "" {
		query += fmt.Sprintf(" AND house_id = @p%d", p)
		args = append(args, hid)
		p++
	}
	query += " ORDER BY autoID DESC"

	if err := h.db.Select(&users, query, args...); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.ListResponse{Data: users, Total: len(users)})
}

func (h *UserHandler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	var user model.User
	if err := h.db.Get(&user, "SELECT * FROM tb_user WHERE user_id = @p1 AND is_active = 1 AND is_delete = 0", id); err != nil {
		return c.Status(404).JSON(model.ErrorResponse{Error: "user not found"})
	}
	return c.JSON(user)
}

func (h *UserHandler) Create(c *fiber.Ctx) error {
	var body model.User
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	body.Prefix = "USR"
	body.UpdateBy = "System"
	body.IsActive = true
	if body.Role == "" {
		body.Role = "RESIDENT"
	}
	body.IDStatus = "ACTIVE"

	var generatedID string
	err := h.db.QueryRow(`
		INSERT INTO tb_user (prefix, user_id, project_id, house_id, full_name, phone_number, line_id, role, update_by, is_active, id_status)
		OUTPUT INSERTED.user_id
		VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9, @p10, @p11)`,
		body.Prefix, "", body.ProjectID, body.HouseID, body.FullName,
		body.PhoneNumber, body.LineID, body.Role, body.UpdateBy, body.IsActive, body.IDStatus,
	).Scan(&generatedID)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	h.db.Get(&body, "SELECT * FROM tb_user WHERE user_id = @p1", generatedID)
	return c.Status(201).JSON(model.SuccessResponse{Message: "created", Data: body})
}

func (h *UserHandler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	var body model.User
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}

	_, err := h.db.Exec(`
		UPDATE tb_user SET full_name = @p1, phone_number = @p2, line_id = @p3, role = @p4, house_id = @p5, update_by = @p6
		WHERE user_id = @p7 AND is_active = 1`,
		body.FullName, body.PhoneNumber, body.LineID, body.Role, body.HouseID, "System", id,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	var u model.User
	h.db.Get(&u, "SELECT * FROM tb_user WHERE user_id = @p1", id)
	return c.JSON(model.SuccessResponse{Message: "updated", Data: u})
}

func (h *UserHandler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	_, err := h.db.Exec("UPDATE tb_user SET is_active = 0, update_by = @p1 WHERE user_id = @p2", "System", id)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.SuccessResponse{Message: "deleted"})
}
