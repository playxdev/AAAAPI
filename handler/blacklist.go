package handler

import (
	"aaaapi/model"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type BlacklistHandler struct {
	db *sqlx.DB
}

func NewBlacklistHandler(db *sqlx.DB) *BlacklistHandler {
	return &BlacklistHandler{db: db}
}

func (h *BlacklistHandler) List(c *fiber.Ctx) error {
	var items = make([]model.Blacklist, 0)
	query := "SELECT * FROM tb_blacklist WHERE is_active = 1 AND is_delete = 0"
	args := []interface{}{}
	p := 1

	if pid := c.Query("project_id"); pid != "" {
		query += fmt.Sprintf(" AND project_id = @p%d", p)
		args = append(args, pid)
		p++
	}
	if lp := c.Query("license_plate"); lp != "" {
		query += fmt.Sprintf(" AND license_plate LIKE @p%d", p)
		args = append(args, "%"+lp+"%")
		p++
	}
	query += " ORDER BY autoID DESC"

	if err := h.db.Select(&items, query, args...); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.ListResponse{Data: items, Total: len(items)})
}

func (h *BlacklistHandler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	var item model.Blacklist
	if err := h.db.Get(&item, "SELECT * FROM tb_blacklist WHERE blacklist_id = @p1 AND is_active = 1 AND is_delete = 0", id); err != nil {
		return c.Status(404).JSON(model.ErrorResponse{Error: "blacklist entry not found"})
	}
	return c.JSON(item)
}

func (h *BlacklistHandler) Check(c *fiber.Ctx) error {
	plate := c.Params("plate")
	projectID := c.Query("project_id")

	if projectID == "" {
		return c.Status(400).JSON(model.ErrorResponse{Error: "project_id query parameter is required"})
	}

	var item model.Blacklist
	err := h.db.Get(&item,
		"SELECT * FROM tb_blacklist WHERE license_plate = @p1 AND project_id = @p2 AND is_active = 1 AND is_delete = 0",
		plate, projectID,
	)
	if err != nil {
		return c.JSON(fiber.Map{"blacklisted": false})
	}
	return c.JSON(fiber.Map{"blacklisted": true, "reason": item.Reason, "blacklist_id": item.BlacklistID})
}

func (h *BlacklistHandler) Create(c *fiber.Ctx) error {
	var body model.Blacklist
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	body.BlacklistID = fmt.Sprintf("BLK-%s", time.Now().Format("20060102150405"))
	body.Prefix = "BLK"
	body.UpdateBy = "System"
	body.IsActive = true
	body.IDStatus = "ACTIVE"

	_, err := h.db.Exec(`
		INSERT INTO tb_blacklist (prefix, blacklist_id, project_id, license_plate, reason, update_by, is_active, id_status)
		VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8)`,
		body.Prefix, body.BlacklistID, body.ProjectID, body.LicensePlate, body.Reason,
		body.UpdateBy, body.IsActive, body.IDStatus,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	h.db.Get(&body, "SELECT * FROM tb_blacklist WHERE blacklist_id = @p1", body.BlacklistID)
	return c.Status(201).JSON(model.SuccessResponse{Message: "created", Data: body})
}

func (h *BlacklistHandler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	var body model.Blacklist
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}

	_, err := h.db.Exec(`
		UPDATE tb_blacklist SET license_plate = @p1, reason = @p2, update_by = @p3
		WHERE blacklist_id = @p4 AND is_active = 1`,
		body.LicensePlate, body.Reason, "System", id,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	var b model.Blacklist
	h.db.Get(&b, "SELECT * FROM tb_blacklist WHERE blacklist_id = @p1", id)
	return c.JSON(model.SuccessResponse{Message: "updated", Data: b})
}

func (h *BlacklistHandler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	_, err := h.db.Exec("UPDATE tb_blacklist SET is_active = 0, update_by = @p1 WHERE blacklist_id = @p2", "System", id)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.SuccessResponse{Message: "deleted"})
}
