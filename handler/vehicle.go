package handler

import (
	"aaaapi/model"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type VehicleHandler struct {
	db *sqlx.DB
}

func NewVehicleHandler(db *sqlx.DB) *VehicleHandler {
	return &VehicleHandler{db: db}
}

func (h *VehicleHandler) List(c *fiber.Ctx) error {
	var vehicles = make([]model.Vehicle, 0)
	query := "SELECT * FROM tb_vehicle WHERE is_active = 1 AND is_delete = 0"
	args := []interface{}{}
	p := 1

	if pid := c.Query("project_id"); pid != "" {
		query += fmt.Sprintf(" AND project_id = @p%d", p)
		args = append(args, pid)
		p++
	}
	if uid := c.Query("user_id"); uid != "" {
		query += fmt.Sprintf(" AND user_id = @p%d", p)
		args = append(args, uid)
		p++
	}
	if lp := c.Query("license_plate"); lp != "" {
		query += fmt.Sprintf(" AND license_plate LIKE @p%d", p)
		args = append(args, "%"+lp+"%")
		p++
	}
	query += " ORDER BY autoID DESC"

	if err := h.db.Select(&vehicles, query, args...); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.ListResponse{Data: vehicles, Total: len(vehicles)})
}

func (h *VehicleHandler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	var vehicle model.Vehicle
	if err := h.db.Get(&vehicle, "SELECT * FROM tb_vehicle WHERE vehicle_id = @p1 AND is_active = 1 AND is_delete = 0", id); err != nil {
		return c.Status(404).JSON(model.ErrorResponse{Error: "vehicle not found"})
	}
	return c.JSON(vehicle)
}

func (h *VehicleHandler) Create(c *fiber.Ctx) error {
	var body model.Vehicle
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	body.VehicleID = fmt.Sprintf("VEH-%s", time.Now().Format("20060102150405"))
	body.Prefix = "VEH"
	body.UpdateBy = "System"
	body.IsActive = true
	body.IDStatus = "ACTIVE"

	_, err := h.db.Exec(`
		INSERT INTO tb_vehicle (prefix, vehicle_id, project_id, user_id, license_plate, province, brand, color, update_by, is_active, id_status)
		VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9, @p10, @p11)`,
		body.Prefix, body.VehicleID, body.ProjectID, body.UserID, body.LicensePlate,
		body.Province, body.Brand, body.Color, body.UpdateBy, body.IsActive, body.IDStatus,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	h.db.Get(&body, "SELECT * FROM tb_vehicle WHERE vehicle_id = @p1", body.VehicleID)
	return c.Status(201).JSON(model.SuccessResponse{Message: "created", Data: body})
}

func (h *VehicleHandler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	var body model.Vehicle
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}

	_, err := h.db.Exec(`
		UPDATE tb_vehicle SET license_plate = @p1, province = @p2, brand = @p3, color = @p4, update_by = @p5
		WHERE vehicle_id = @p6 AND is_active = 1`,
		body.LicensePlate, body.Province, body.Brand, body.Color, "System", id,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	var v model.Vehicle
	h.db.Get(&v, "SELECT * FROM tb_vehicle WHERE vehicle_id = @p1", id)
	return c.JSON(model.SuccessResponse{Message: "updated", Data: v})
}

func (h *VehicleHandler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	_, err := h.db.Exec("UPDATE tb_vehicle SET is_active = 0, update_by = @p1 WHERE vehicle_id = @p2", "System", id)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.SuccessResponse{Message: "deleted"})
}
