package middleware

import (
	"aaaapi/model"
	"os"
	"path/filepath"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

func Setup(app *fiber.App) {
	app.Use(recover.New())
	app.Use(logger.New(logger.Config{
		Format: "${time} | ${status} | ${latency} | ${method} ${path}\n",
	}))
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders: "Content-Type,Authorization",
	}))
}

func AdminStatic(adminDist string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if adminDist == "" {
			return c.Next()
		}
		path := c.Path()
		target := filepath.Join(adminDist, path)
		if path == "/" {
			target = filepath.Join(adminDist, "index.html")
		}
		if _, err := os.Stat(target); err == nil {
			return c.SendFile(target)
		}
		return c.Next()
	}
}

func NotFoundHandler(c *fiber.Ctx) error {
	return c.Status(404).JSON(model.ErrorResponse{Error: "route not found"})
}
