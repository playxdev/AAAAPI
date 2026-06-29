package router

import (
	"aaaapi/handler"
	"aaaapi/middleware"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

func Setup(app *fiber.App, db *sqlx.DB, jwtSecret, apiKey, adminDist string) {
	ph := handler.NewProjectHandler(db)
	hh := handler.NewHouseHandler(db)
	uh := handler.NewUserHandler(db)
	vh := handler.NewVehicleHandler(db)
	dh := handler.NewDeviceHandler(db)
	ah := handler.NewAccessLogHandler(db)
	bh := handler.NewBlacklistHandler(db)
	eh := handler.NewEdgeHandler(db)
	auth := handler.NewAuthHandler(db, jwtSecret)

	api := app.Group("/api/v1")

	// Public
	api.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})
	api.Post("/auth/login", auth.Login)
	api.Post("/auth/admin/login", auth.AdminLogin)

	// Edge (API key auth — optional, microcontrollers call these)
	edge := api.Group("/edge", middleware.EdgeAuth(apiKey))
	edge.Get("/sync/pull", eh.PullData)
	edge.Post("/sync/push", eh.PushLogs)
	edge.Get("/validate/:plate", eh.Validate)
	edge.Get("/check/:plate", bh.Check)

	// Protected (JWT auth — mobile/web clients)
	protected := api.Group("", middleware.JWTAuth([]byte(jwtSecret)))

	// Projects
	protected.Get("/projects", ph.List)
	protected.Get("/projects/:id", ph.Get)
	protected.Post("/projects", ph.Create)
	protected.Put("/projects/:id", ph.Update)
	protected.Delete("/projects/:id", ph.Delete)

	// Houses
	protected.Get("/houses", hh.List)
	protected.Get("/houses/:id", hh.Get)
	protected.Post("/houses", hh.Create)
	protected.Put("/houses/:id", hh.Update)
	protected.Delete("/houses/:id", hh.Delete)

	// Users
	protected.Get("/users", uh.List)
	protected.Get("/users/:id", uh.Get)
	protected.Post("/users", uh.Create)
	protected.Put("/users/:id", uh.Update)
	protected.Delete("/users/:id", uh.Delete)

	// Vehicles
	protected.Get("/vehicles", vh.List)
	protected.Get("/vehicles/:id", vh.Get)
	protected.Post("/vehicles", vh.Create)
	protected.Put("/vehicles/:id", vh.Update)
	protected.Delete("/vehicles/:id", vh.Delete)

	// Devices
	protected.Get("/devices", dh.List)
	protected.Get("/devices/:id", dh.Get)
	protected.Post("/devices", dh.Create)
	protected.Put("/devices/:id", dh.Update)
	protected.Delete("/devices/:id", dh.Delete)

	// Access Logs
	protected.Get("/access-logs", ah.List)
	protected.Get("/access-logs/:id", ah.Get)
	protected.Post("/access-logs", ah.Create)

	// Blacklist
	protected.Get("/blacklist", bh.List)
	protected.Get("/blacklist/:id", bh.Get)
	protected.Post("/blacklist", bh.Create)
	protected.Put("/blacklist/:id", bh.Update)
	protected.Delete("/blacklist/:id", bh.Delete)

	// Blacklist check (also available at JWT-protected path)
	protected.Get("/blacklist/check/:plate", bh.Check)

	app.Use(middleware.AdminStatic(adminDist))
	app.Use(middleware.NotFoundHandler)
}
