package handler

import (
	"aaaapi/model"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

type ProjectHandler struct {
	db *sqlx.DB
}

func NewProjectHandler(db *sqlx.DB) *ProjectHandler {
	return &ProjectHandler{db: db}
}

func (h *ProjectHandler) List(c *fiber.Ctx) error {
	var projects = make([]model.Project, 0)
	query := "SELECT * FROM tb_project WHERE is_active = 1 AND is_delete = 0"
	args := []interface{}{}

	if pid := c.Query("project_id"); pid != "" {
		query += " AND project_id = @p1"
		args = append(args, pid)
	}
	query += " ORDER BY autoID DESC"

	if err := h.db.Select(&projects, query, args...); err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	return c.JSON(model.ListResponse{Data: projects, Total: len(projects)})
}

func (h *ProjectHandler) Get(c *fiber.Ctx) error {
	id := c.Params("id")
	var project model.Project
	if err := h.db.Get(&project, "SELECT * FROM tb_project WHERE project_id = @p1 AND is_active = 1 AND is_delete = 0", id); err != nil {
		return c.Status(404).JSON(model.ErrorResponse{Error: "project not found"})
	}
	return c.JSON(project)
}

func (h *ProjectHandler) Create(c *fiber.Ctx) error {
	var p model.Project
	if err := c.BodyParser(&p); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}
	p.Prefix = "PRJ"
	p.UpdateBy = "System"
	p.IsActive = true
	p.IDStatus = "ACTIVE"

	var generatedID string
	err := h.db.QueryRow(`
		INSERT INTO tb_project (prefix, project_id, project_name, address, contact_number, update_by, is_active, id_status)
		OUTPUT INSERTED.project_id
		VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8)`,
		p.Prefix, "", p.ProjectName, p.Address, p.ContactNumber, p.UpdateBy, p.IsActive, p.IDStatus,
	).Scan(&generatedID)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	h.db.Get(&p, "SELECT * FROM tb_project WHERE project_id = @p1", generatedID)
	return c.Status(201).JSON(model.SuccessResponse{Message: "created", Data: p})
}

func (h *ProjectHandler) Update(c *fiber.Ctx) error {
	id := c.Params("id")
	var body model.Project
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(model.ErrorResponse{Error: err.Error()})
	}

	_, err := h.db.Exec(`
		UPDATE tb_project SET project_name = @p1, address = @p2, contact_number = @p3, update_by = @p4
		WHERE project_id = @p5 AND is_active = 1`,
		body.ProjectName, body.Address, body.ContactNumber, "System", id,
	)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}

	var p model.Project
	h.db.Get(&p, "SELECT * FROM tb_project WHERE project_id = @p1", id)
	return c.JSON(model.SuccessResponse{Message: "updated", Data: p})
}

func (h *ProjectHandler) Delete(c *fiber.Ctx) error {
	id := c.Params("id")
	_, err := h.db.Exec("UPDATE tb_project SET is_active = 0, update_by = @p1 WHERE project_id = @p2", "System", id)
	if err != nil {
		return c.Status(500).JSON(model.ErrorResponse{Error: err.Error()})
	}
	return c.JSON(model.SuccessResponse{Message: "deleted"})
}
