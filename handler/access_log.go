package handler

import (
	"aaaapi/model"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type AccessLogHandler struct {
	db *sqlx.DB
}

func NewAccessLogHandler(db *sqlx.DB) *AccessLogHandler {
	return &AccessLogHandler{db: db}
}

func (h *AccessLogHandler) List(c *fiber.Ctx) error {
	var logs = make([]model.AccessLog, 0)
	query := "SELECT * FROM tb_access_log WHERE is_active = 1 AND is_delete = 0"
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
	if dateFrom := c.Query("date_from"); dateFrom != "" {
		query += fmt.Sprintf(" AND access_date >= @p%d", p)
		args = append(args, dateFrom)
		p++
	}
	if dateTo := c.Query("date_to"); dateTo != "" {
		query += fmt.Sprintf(" AND access_date <= @p%d", p)
		args = append(args, dateTo)
		p++
	}
	query += " ORDER BY access_date DESC"

	if err := h.db.Select(&logs, query, args...); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.ListResponse{Data: logs, Total: len(logs)})
}

func (h *AccessLogHandler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	var log model.AccessLog
	if err := h.db.Get(&log, "SELECT * FROM tb_access_log WHERE log_id = @p1 AND is_active = 1 AND is_delete = 0", id); err != nil {
		return c.Status(404).JSON(model.ErrorResponse{Error: "access log not found"})
	}
	return c.JSON(log)
}

func (h *AccessLogHandler) Create(c *fiber.Ctx) error {
	var body model.AccessLog
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	body.Prefix = "ACL"
	body.UpdateBy = "System"
	body.IsActive = true
	body.IDStatus = "SUCCESS"

	if body.AccessDate.IsZero() {
		body.AccessDate = time.Now()
	}

	var generatedID string
	err := h.db.QueryRow(`
		INSERT INTO tb_access_log (prefix, log_id, project_id, device_id, license_plate, access_type, user_type, access_date, image_url, remark, is_success, update_by, is_active, id_status)
		OUTPUT INSERTED.log_id
		VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9, @p10, @p11, @p12, @p13, @p14)`,
		body.Prefix, "", body.ProjectID, body.DeviceID, body.LicensePlate,
		body.AccessType, body.UserType, body.AccessDate, body.ImageURL, body.Remark,
		body.IsSuccess, body.UpdateBy, body.IsActive, body.IDStatus,
	).Scan(&generatedID)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	h.db.Get(&body, "SELECT * FROM tb_access_log WHERE log_id = @p1", generatedID)
	return c.Status(201).JSON(model.SuccessResponse{Message: "created", Data: body})
}
