package handler

import (
	"database/sql/driver"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
)

var testTime = time.Date(2026, 6, 26, 12, 0, 0, 0, time.UTC)

var projectColumns = []string{"autoID", "prefix", "project_id", "project_name", "address", "contact_number", "update_by", "update_date", "is_active", "is_delete", "id_status"}

var houseColumns = []string{"autoID", "prefix", "house_id", "project_id", "house_number", "zone_or_soi", "update_by", "update_date", "is_active", "is_delete", "id_status"}

var userColumns = []string{"autoID", "prefix", "user_id", "project_id", "house_id", "full_name", "phone_number", "line_id", "role", "update_by", "update_date", "is_active", "is_delete", "id_status"}

var vehicleColumns = []string{"autoID", "prefix", "vehicle_id", "project_id", "user_id", "license_plate", "province", "brand", "color", "update_by", "update_date", "is_active", "is_delete", "id_status"}

var deviceColumns = []string{"autoID", "prefix", "device_id", "project_id", "gate_name", "device_type", "ip_address", "update_by", "update_date", "is_active", "is_delete", "id_status"}

var accessLogColumns = []string{"autoID", "prefix", "log_id", "project_id", "device_id", "license_plate", "access_type", "user_type", "access_date", "image_url", "remark", "is_success", "update_by", "update_date", "is_active", "is_delete", "id_status"}

var blacklistColumns = []string{"autoID", "prefix", "blacklist_id", "project_id", "license_plate", "reason", "update_by", "update_date", "is_active", "is_delete", "id_status"}

func newMockDB() (*sqlx.DB, sqlmock.Sqlmock) {
	db, mock, _ := sqlmock.New()
	return sqlx.NewDb(db, "sqlmock"), mock
}

func setupTestApp(method, path string, handler fiber.Handler) *fiber.App {
	app := fiber.New()
	switch method {
	case "GET":
		app.Get(path, handler)
	case "POST":
		app.Post(path, handler)
	case "PUT":
		app.Put(path, handler)
	case "DELETE":
		app.Delete(path, handler)
	}
	return app
}

func projectRow(id int, pid, name string) []driver.Value {
	return []driver.Value{id, "PRJ", pid, name, nil, nil, "System", testTime, true, false, "ACTIVE"}
}

func houseRow(id int, hid, pid, num string) []driver.Value {
	return []driver.Value{id, "HSE", hid, pid, num, nil, "System", testTime, true, false, "ACTIVE"}
}

func userRow(id int, uid, pid, name string) []driver.Value {
	return []driver.Value{id, "USR", uid, pid, nil, name, nil, nil, "RESIDENT", "System", testTime, true, false, "ACTIVE"}
}

func vehicleRow(id int, vid, pid, uid, lp string) []driver.Value {
	return []driver.Value{id, "VEH", vid, pid, uid, lp, nil, nil, nil, "System", testTime, true, false, "ACTIVE"}
}

func deviceRow(id int, did, pid, gate string) []driver.Value {
	return []driver.Value{id, "DEV", did, pid, gate, nil, nil, "System", testTime, true, false, "ACTIVE"}
}

func accessLogRow(id int, lid, pid, lp string) []driver.Value {
	return []driver.Value{id, "ACL", lid, pid, nil, lp, "ENTRY", "RESIDENT", testTime, nil, nil, true, "System", testTime, true, false, "SUCCESS"}
}

func blacklistRow(id int, bid, pid, lp string) []driver.Value {
	return []driver.Value{id, "BLK", bid, pid, lp, nil, "System", testTime, true, false, "ACTIVE"}
}
