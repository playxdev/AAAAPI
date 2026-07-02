package handler

import (
	"aaaapi/model"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type EdgeHandler struct {
	db *sqlx.DB
}

func NewEdgeHandler(db *sqlx.DB) *EdgeHandler {
	return &EdgeHandler{db: db}
}

func (h *EdgeHandler) Validate(c *fiber.Ctx) error {
	plate := c.Params("plate")
	projectID := c.Query("project_id")

	if plate == "" || projectID == "" {
		return c.Status(400).JSON(model.ErrorResponse{Error: "license_plate and project_id are required"})
	}

	var blacklist model.Blacklist
	if err := h.db.Get(&blacklist,
		"SELECT * FROM tb_blacklist WHERE license_plate = @p1 AND project_id = @p2 AND is_active = 1 AND is_delete = 0",
		plate, projectID,
	); err == nil {
		reason := "blacklisted"
		if blacklist.Reason != nil {
			reason = *blacklist.Reason
		}
		return c.JSON(model.ValidateResponse{
			Allowed:      false,
			Reason:       reason,
			LicensePlate: plate,
			AccessType:   "DENIED",
		})
	}

	var vehicle model.Vehicle
	if err := h.db.Get(&vehicle,
		"SELECT * FROM tb_vehicle WHERE license_plate = @p1 AND project_id = @p2 AND is_active = 1 AND is_delete = 0",
		plate, projectID,
	); err == nil {
		var user model.User
		if err := h.db.Get(&user,
			"SELECT * FROM tb_user WHERE user_id = @p1 AND is_active = 1 AND is_delete = 0",
			vehicle.UserID,
		); err == nil {
			var house model.House
			houseNumber := ""
			if user.HouseID != nil {
				if err := h.db.Get(&house,
					"SELECT * FROM tb_house WHERE house_id = @p1 AND is_active = 1 AND is_delete = 0",
					*user.HouseID,
				); err == nil {
					houseNumber = house.HouseNumber
				}
			}
			return c.JSON(model.ValidateResponse{
				Allowed:      true,
				Reason:       "registered",
				LicensePlate: plate,
				UserID:       user.UserID,
				FullName:     user.FullName,
				HouseNumber:  houseNumber,
				AccessType:   "GRANTED",
			})
		}
	}

	return c.JSON(model.ValidateResponse{
		Allowed:      false,
		Reason:       "unknown",
		LicensePlate: plate,
		AccessType:   "UNKNOWN",
	})
}

func (h *EdgeHandler) PullData(c *fiber.Ctx) error {
	projectID := c.Query("project_id")
	if projectID == "" {
		return c.Status(400).JSON(model.ErrorResponse{Error: "project_id is required"})
	}

	vehicles := make([]model.Vehicle, 0)
	users := make([]model.User, 0)
	devices := make([]model.Device, 0)
	blacklist := make([]model.Blacklist, 0)

	if err := h.db.Select(&vehicles,
		"SELECT * FROM tb_vehicle WHERE project_id = @p1 AND is_active = 1 AND is_delete = 0", projectID); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	if err := h.db.Select(&users,
		"SELECT * FROM tb_user WHERE project_id = @p1 AND is_active = 1 AND is_delete = 0", projectID); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	if err := h.db.Select(&devices,
		"SELECT * FROM tb_device WHERE project_id = @p1 AND is_active = 1 AND is_delete = 0", projectID); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	if err := h.db.Select(&blacklist,
		"SELECT * FROM tb_blacklist WHERE project_id = @p1 AND is_active = 1 AND is_delete = 0", projectID); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	resp := model.EdgeSyncPullResponse{
		ProjectID: projectID,
		SyncedAt:  time.Now(),
		Data: model.EdgeSyncData{
			Vehicles:  vehicles,
			Users:     users,
			Devices:   devices,
			Blacklist: blacklist,
		},
	}
	return c.JSON(resp)
}

func (h *EdgeHandler) PushLogs(c *fiber.Ctx) error {
	var req model.EdgeSyncPushRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	if req.ProjectID == "" {
		return c.Status(400).JSON(model.ErrorResponse{Error: "project_id is required"})
	}
	if len(req.Logs) == 0 {
		return c.Status(400).JSON(model.ErrorResponse{Error: "logs array is empty"})
	}

	now := time.Now()
	count := 0

	tx, err := h.db.Beginx()
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	defer tx.Rollback()

	for _, entry := range req.Logs {
		accessDate := entry.AccessDate
		if accessDate.IsZero() {
			accessDate = now
		}

		_, err := tx.Exec(`
			INSERT INTO tb_access_log (prefix, log_id, project_id, device_id, license_plate, access_type, user_type, access_date, image_url, remark, is_success, update_by, is_active, id_status)
			VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9, @p10, @p11, @p12, @p13, @p14)`,
			"ACL", "", req.ProjectID, req.DeviceID, entry.LicensePlate,
			entry.AccessType, entry.UserType, accessDate, entry.ImageURL, entry.Remark,
			entry.IsSuccess, "Edge", true, "SUCCESS",
		)
		if err != nil {
			return c.Status(500).JSON(model.ErrorResponse{Error: fmt.Sprintf("batch insert error at index %d: %v", count, err)})
		}
		count++
	}

	if err := tx.Commit(); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	return c.Status(201).JSON(model.SuccessResponse{
		Message: fmt.Sprintf("synced %d logs", count),
		Data:    fiber.Map{"synced_count": count},
	})
}
