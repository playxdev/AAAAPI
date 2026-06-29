package database

import (
	"fmt"
	"log"

	"github.com/jmoiron/sqlx"

	_ "github.com/denisenkom/go-mssqldb"

	"aaaapi/config"
)

var DB *sqlx.DB

func Connect(cfg config.DBConfig) {
	var err error
	DB, err = sqlx.Connect("sqlserver", cfg.ConnString())
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}

	DB.SetMaxOpenConns(25)
	DB.SetMaxIdleConns(10)

	if err = DB.Ping(); err != nil {
		log.Fatalf("failed to ping database: %v", err)
	}

	fmt.Println("connected to database")
}

func Close() {
	if DB != nil {
		DB.Close()
	}
}
