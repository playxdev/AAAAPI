package config

import (
	"fmt"
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	Port      string
	JWTSecret string
	APIKey    string
	DB        DBConfig
}

type DBConfig struct {
	Server   string
	Port     string
	User     string
	Password string
	Database string
	Encrypt  string
}

func (c DBConfig) ConnString() string {
	return fmt.Sprintf(
		"server=%s;port=%s;user id=%s;password=%s;database=%s;encrypt=%s",
		c.Server, c.Port, c.User, c.Password, c.Database, c.Encrypt,
	)
}

func Load() *Config {
	godotenv.Load()

	return &Config{
		Port:      getEnv("FIBER_PORT", "3000"),
		JWTSecret: getEnv("JWT_SECRET", "default-secret-change-me"),
		APIKey:    getEnv("API_KEY", ""),
		DB: DBConfig{
			Server:   getEnv("DB_HOST", "localhost"),
			Port:     getEnv("DB_PORT", "1433"),
			User:     getEnv("DB_USER", "sa"),
			Password: getEnv("DB_PASSWORD", ""),
			Database: getEnv("DB_NAME", "AAA"),
			Encrypt:  getEnv("DB_ENCRYPT", "disable"),
		},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
