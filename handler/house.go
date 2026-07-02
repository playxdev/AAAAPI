package handler

import (
	"aaaapi/model"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type HouseHandler struct {
	db *sqlx.DB
}

func NewHouseHandler(db *sqlx.DB) *HouseHandler {
	return &HouseHandler{db: db}
}

func (h *HouseHandler) List(c *fiber.Ctx) error {
	var houses = make([]model.House, 0)
	query := "SELECT * FROM tb_house WHERE is_active = 1 AND is_delete = 0"
	args := []interface{}{}

	if pid := c.Query("project_id"); pid != "" {
		query += " AND project_id = @p1"
		args = append(args, pid)
	}
	query += " ORDER BY autoID DESC"

	if err := h.db.Select(&houses, query, args...); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.ListResponse{Data: houses, Total: len(houses)})
}

func (h *HouseHandler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	var house model.House
	if err := h.db.Get(&house, "SELECT * FROM tb_house WHERE house_id = @p1 AND is_active = 1 AND is_delete = 0", id); err != nil {
		return c.Status(404).JSON(model.ErrorResponse{Error: "house not found"})
	}
	return c.JSON(house)
}

func (h *HouseHandler) Create(c *fiber.Ctx) error {
	var body model.House
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	body.Prefix = "HSE"
	body.UpdateBy = "System"
	body.IsActive = true
	body.IDStatus = "ACTIVE"

	var generatedID string
	err := h.db.QueryRow(`
		INSERT INTO tb_house (prefix, house_id, project_id, house_number, zone_or_soi, update_by, is_active, id_status)
		OUTPUT INSERTED.house_id
		VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8)`,
		body.Prefix, "", body.ProjectID, body.HouseNumber, body.ZoneOrSoi, body.UpdateBy, body.IsActive, body.IDStatus,
	).Scan(&generatedID)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	h.db.Get(&body, "SELECT * FROM tb_house WHERE house_id = @p1", generatedID)
	return c.Status(201).JSON(model.SuccessResponse{Message: "created", Data: body})
}

func (h *HouseHandler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	var body model.House
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}

	_, err := h.db.Exec(`
		UPDATE tb_house SET house_number = @p1, zone_or_soi = @p2, project_id = @p3, update_by = @p4
		WHERE house_id = @p5 AND is_active = 1`,
		body.HouseNumber, body.ZoneOrSoi, body.ProjectID, "System", id,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	var house model.House
	h.db.Get(&house, "SELECT * FROM tb_house WHERE house_id = @p1", id)
	return c.JSON(model.SuccessResponse{Message: "updated", Data: house})
}

func (h *HouseHandler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	_, err := h.db.Exec("UPDATE tb_house SET is_active = 0, update_by = @p1 WHERE house_id = @p2", "System", id)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.SuccessResponse{Message: "deleted"})
}
