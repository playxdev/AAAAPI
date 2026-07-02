package main

import (
	"aaaapi/config"
	"aaaapi/database"
	"aaaapi/middleware"
	"aaaapi/router"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/gofiber/fiber/v2"
)

func buildAdmin() string {
	adminRoot := filepath.Join("..", "AAAADMIN")
	dist := filepath.Join(adminRoot, "dist")
	index := filepath.Join(dist, "index.html")

	if _, err := os.Stat(index); err == nil {
		return dist
	}

	log.Println("Admin dist not found, building frontend...")
	cmd := exec.Command("npm", "run", "build")
	cmd.Dir = adminRoot
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("Admin build failed (serving API only): %s", string(out))
		return ""
	}
	log.Println("Admin frontend built successfully")
	return dist
}

func main() {
	cfg := config.Load()

	database.Connect(cfg.DB)
	defer database.Close()

	app := fiber.New(fiber.Config{
		AppName: "AAA API v1.0",
	})

	middleware.Setup(app)

	adminDist := buildAdmin()
	router.Setup(app, database.DB, cfg.JWTSecret, cfg.APIKey, adminDist)

	addr := fmt.Sprintf(":%s", cfg.Port)
	log.Printf("AAA API starting on http://localhost%s", addr)
	if err := app.Listen(addr); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
