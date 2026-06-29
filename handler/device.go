package handler

import (
	"aaaapi/model"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type DeviceHandler struct {
	db *sqlx.DB
}

func NewDeviceHandler(db *sqlx.DB) *DeviceHandler {
	return &DeviceHandler{db: db}
}

func (h *DeviceHandler) List(c *fiber.Ctx) error {
	var devices = make([]model.Device, 0)
	query := "SELECT * FROM tb_device WHERE is_active = 1 AND is_delete = 0"
	args := []interface{}{}

	if pid := c.Query("project_id"); pid != "" {
		query += " AND project_id = @p1"
		args = append(args, pid)
	}
	query += " ORDER BY autoID DESC"

	if err := h.db.Select(&devices, query, args...); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.ListResponse{Data: devices, Total: len(devices)})
}

func (h *DeviceHandler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	var device model.Device
	if err := h.db.Get(&device, "SELECT * FROM tb_device WHERE device_id = @p1 AND is_active = 1 AND is_delete = 0", id); err != nil {
		return c.Status(404).JSON(model.ErrorResponse{Error: "device not found"})
	}
	return c.JSON(device)
}

func (h *DeviceHandler) Create(c *fiber.Ctx) error {
	var body model.Device
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	body.DeviceID = fmt.Sprintf("DEV-%s", time.Now().Format("20060102150405"))
	body.Prefix = "DEV"
	body.UpdateBy = "System"
	body.IsActive = true
	body.IDStatus = "ACTIVE"

	_, err := h.db.Exec(`
		INSERT INTO tb_device (prefix, device_id, project_id, gate_name, device_type, ip_address, update_by, is_active, id_status)
		VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9)`,
		body.Prefix, body.DeviceID, body.ProjectID, body.GateName, body.DeviceType, body.IPAddress,
		body.UpdateBy, body.IsActive, body.IDStatus,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	h.db.Get(&body, "SELECT * FROM tb_device WHERE device_id = @p1", body.DeviceID)
	return c.Status(201).JSON(model.SuccessResponse{Message: "created", Data: body})
}

func (h *DeviceHandler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	var body model.Device
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}

	_, err := h.db.Exec(`
		UPDATE tb_device SET gate_name = @p1, device_type = @p2, ip_address = @p3, update_by = @p4
		WHERE device_id = @p5 AND is_active = 1`,
		body.GateName, body.DeviceType, body.IPAddress, "System", id,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	var d model.Device
	h.db.Get(&d, "SELECT * FROM tb_device WHERE device_id = @p1", id)
	return c.JSON(model.SuccessResponse{Message: "updated", Data: d})
}

func (h *DeviceHandler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	_, err := h.db.Exec("UPDATE tb_device SET is_active = 0, update_by = @p1 WHERE device_id = @p2", "System", id)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.SuccessResponse{Message: "deleted"})
}
