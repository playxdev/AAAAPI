package model

import "time"

type Project struct {
	AutoID        int        `db:"autoID"        json:"auto_id"`
	Prefix        string     `db:"prefix"        json:"prefix"`
	ProjectID     string     `db:"project_id"    json:"project_id"`
	ProjectName   string     `db:"project_name"  json:"project_name"`
	Address       *string    `db:"address"       json:"address"`
	ContactNumber *string    `db:"contact_number" json:"contact_number"`
	UpdateBy      string     `db:"update_by"     json:"update_by"`
	UpdateDate    time.Time  `db:"update_date"   json:"update_date"`
	IsActive      bool       `db:"is_active"     json:"is_active"`
	IsDelete      bool       `db:"is_delete"     json:"is_delete"`
	IDStatus      string     `db:"id_status"     json:"id_status"`
}

type House struct {
	AutoID      int       `db:"autoID"       json:"auto_id"`
	Prefix      string    `db:"prefix"       json:"prefix"`
	HouseID     string    `db:"house_id"     json:"house_id"`
	ProjectID   string    `db:"project_id"   json:"project_id"`
	HouseNumber string    `db:"house_number" json:"house_number"`
	ZoneOrSoi   *string   `db:"zone_or_soi"  json:"zone_or_soi"`
	UpdateBy    string    `db:"update_by"    json:"update_by"`
	UpdateDate  time.Time `db:"update_date"  json:"update_date"`
	IsActive    bool      `db:"is_active"    json:"is_active"`
	IsDelete    bool      `db:"is_delete"    json:"is_delete"`
	IDStatus    string    `db:"id_status"    json:"id_status"`
}

type User struct {
	AutoID      int       `db:"autoID"       json:"auto_id"`
	Prefix      string    `db:"prefix"       json:"prefix"`
	UserID      string    `db:"user_id"      json:"user_id"`
	ProjectID   string    `db:"project_id"   json:"project_id"`
	HouseID     *string   `db:"house_id"     json:"house_id"`
	FullName    string    `db:"full_name"    json:"full_name"`
	PhoneNumber *string   `db:"phone_number" json:"phone_number"`
	LineID      *string   `db:"line_id"      json:"line_id"`
	Role        string    `db:"role"         json:"role"`
	UpdateBy    string    `db:"update_by"    json:"update_by"`
	UpdateDate  time.Time `db:"update_date"  json:"update_date"`
	IsActive    bool      `db:"is_active"    json:"is_active"`
	IsDelete    bool      `db:"is_delete"    json:"is_delete"`
	IDStatus    string    `db:"id_status"    json:"id_status"`
}

type Vehicle struct {
	AutoID       int       `db:"autoID"        json:"auto_id"`
	Prefix       string    `db:"prefix"        json:"prefix"`
	VehicleID    string    `db:"vehicle_id"    json:"vehicle_id"`
	ProjectID    string    `db:"project_id"    json:"project_id"`
	UserID       string    `db:"user_id"       json:"user_id"`
	LicensePlate string    `db:"license_plate" json:"license_plate"`
	Province     *string   `db:"province"      json:"province"`
	Brand        *string   `db:"brand"         json:"brand"`
	Color        *string   `db:"color"         json:"color"`
	UpdateBy     string    `db:"update_by"     json:"update_by"`
	UpdateDate   time.Time `db:"update_date"   json:"update_date"`
	IsActive     bool      `db:"is_active"     json:"is_active"`
	IsDelete     bool      `db:"is_delete"     json:"is_delete"`
	IDStatus     string    `db:"id_status"     json:"id_status"`
}

type Device struct {
	AutoID     int       `db:"autoID"      json:"auto_id"`
	Prefix     string    `db:"prefix"      json:"prefix"`
	DeviceID   string    `db:"device_id"   json:"device_id"`
	ProjectID  string    `db:"project_id"  json:"project_id"`
	GateName   string    `db:"gate_name"   json:"gate_name"`
	DeviceType *string   `db:"device_type" json:"device_type"`
	IPAddress  *string   `db:"ip_address"  json:"ip_address"`
	UpdateBy   string    `db:"update_by"   json:"update_by"`
	UpdateDate time.Time `db:"update_date" json:"update_date"`
	IsActive   bool      `db:"is_active"   json:"is_active"`
	IsDelete   bool      `db:"is_delete"   json:"is_delete"`
	IDStatus   string    `db:"id_status"   json:"id_status"`
}

type AccessLog struct {
	AutoID       int       `db:"autoID"        json:"auto_id"`
	Prefix       string    `db:"prefix"        json:"prefix"`
	LogID        string    `db:"log_id"        json:"log_id"`
	ProjectID    string    `db:"project_id"    json:"project_id"`
	DeviceID     *string   `db:"device_id"     json:"device_id"`
	LicensePlate *string   `db:"license_plate" json:"license_plate"`
	AccessType   *string   `db:"access_type"   json:"access_type"`
	UserType     *string   `db:"user_type"     json:"user_type"`
	AccessDate   time.Time `db:"access_date"   json:"access_date"`
	ImageURL     *string   `db:"image_url"     json:"image_url"`
	Remark       *string   `db:"remark"        json:"remark"`
	IsSuccess    bool      `db:"is_success"    json:"is_success"`
	UpdateBy     string    `db:"update_by"     json:"update_by"`
	UpdateDate   time.Time `db:"update_date"   json:"update_date"`
	IsActive     bool      `db:"is_active"     json:"is_active"`
	IsDelete     bool      `db:"is_delete"     json:"is_delete"`
	IDStatus     string    `db:"id_status"     json:"id_status"`
}

type Blacklist struct {
	AutoID       int       `db:"autoID"        json:"auto_id"`
	Prefix       string    `db:"prefix"        json:"prefix"`
	BlacklistID  string    `db:"blacklist_id"  json:"blacklist_id"`
	ProjectID    string    `db:"project_id"    json:"project_id"`
	LicensePlate string    `db:"license_plate" json:"license_plate"`
	Reason       *string   `db:"reason"        json:"reason"`
	UpdateBy     string    `db:"update_by"     json:"update_by"`
	UpdateDate   time.Time `db:"update_date"   json:"update_date"`
	IsActive     bool      `db:"is_active"     json:"is_active"`
	IsDelete     bool      `db:"is_delete"     json:"is_delete"`
	IDStatus     string    `db:"id_status"     json:"id_status"`
}

type EdgeSyncPullResponse struct {
	ProjectID  string      `json:"project_id"`
	SyncedAt   time.Time   `json:"synced_at"`
	Data       EdgeSyncData `json:"data"`
}

type EdgeSyncData struct {
	Vehicles  []Vehicle  `json:"vehicles"`
	Users     []User     `json:"users"`
	Devices   []Device   `json:"devices"`
	Blacklist []Blacklist `json:"blacklist"`
}

type EdgeSyncPushRequest struct {
	ProjectID string         `json:"project_id"`
	DeviceID  string         `json:"device_id"`
	Logs      []PushLogEntry `json:"logs"`
}

type PushLogEntry struct {
	LicensePlate string    `json:"license_plate"`
	AccessType   string    `json:"access_type"`
	UserType     string    `json:"user_type"`
	AccessDate   time.Time `json:"access_date"`
	ImageURL     string    `json:"image_url"`
	Remark       string    `json:"remark"`
	IsSuccess    bool      `json:"is_success"`
}

type Admin struct {
	AutoID        int       `db:"autoID"         json:"auto_id"`
	Prefix        string    `db:"prefix"         json:"prefix"`
	AdminID       string    `db:"admin_id"       json:"admin_id"`
	AdminName     string    `db:"admin_name"     json:"admin_name"`
	AdminPassword string    `db:"admin_password" json:"-"`
	AdminLevel    string    `db:"admin_level"    json:"admin_level"`
	ProjectID     string    `db:"project_id"     json:"project_id"`
	UpdateBy      string    `db:"update_by"      json:"update_by"`
	UpdateDate    time.Time `db:"update_date"    json:"update_date"`
	IsActive      bool      `db:"is_active"      json:"is_active"`
	IsDelete      bool      `db:"is_delete"      json:"is_delete"`
	IDStatus      string    `db:"id_status"      json:"id_status"`
}

type LoginRequest struct {
	UserID      string `json:"user_id"`
	PhoneNumber string `json:"phone_number"`
}

type LoginResponse struct {
	Token    string `json:"token"`
	UserID   string `json:"user_id"`
	FullName string `json:"full_name"`
	Role     string `json:"role"`
}

type AdminLoginRequest struct {
	AdminName string `json:"admin_name"`
	Password  string `json:"password"`
}

type AdminLoginResponse struct {
	Token     string `json:"token"`
	AdminID   string `json:"admin_id"`
	FullName  string `json:"full_name"`
	Role      string `json:"role"`
	ProjectID string `json:"project_id"`
}

type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

type SuccessResponse struct {
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type ValidateResponse struct {
	Allowed       bool   `json:"allowed"`
	Reason        string `json:"reason"`
	LicensePlate  string `json:"license_plate"`
	UserID        string `json:"user_id,omitempty"`
	FullName      string `json:"full_name,omitempty"`
	HouseNumber   string `json:"house_number,omitempty"`
	AccessType    string `json:"access_type"`
}

type ListResponse struct {
	Data  interface{} `json:"data"`
	Total int         `json:"total"`
}
