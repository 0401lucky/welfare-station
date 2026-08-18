package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime settings loaded from the environment.
// The full env-var list is defined in design.md §11.
type Config struct {
	Port             string
	DBDriver         string // "mysql" (default) or "sqlite" (local dev only)
	DBDSN            string
	NewAPIBaseURL    string
	NewAPIPublicURL  string // new-api 对外访问地址,可选,仅用于绑定引导页跳转
	NewAPIAdminPAT   string
	LinuxDOClientID  string
	LinuxDOClientSec string
	WelfareBaseURL   string
	WelfareJWTSecret string
	WelfareSiteName  string
	AdminLinuxDOIDs  map[string]bool
	QuotaPerUnit     int64
	MaxGrantQuota    int64
	MockOAuth        bool
}

// Get reads configuration from the environment, failing loudly (listing every
// missing/invalid required field) so that misconfiguration is caught at boot.
func Get() (*Config, error) {
	cfg := &Config{
		Port:             strEnv("PORT", "8080"),
		DBDriver:         strEnv("DB_DRIVER", "mysql"),
		DBDSN:            os.Getenv("DB_DSN"),
		NewAPIBaseURL:    strings.TrimRight(os.Getenv("NEWAPI_BASE_URL"), "/"),
		NewAPIPublicURL:  strings.TrimRight(os.Getenv("NEWAPI_PUBLIC_URL"), "/"),
		NewAPIAdminPAT:   os.Getenv("NEWAPI_ADMIN_PAT"),
		LinuxDOClientID:  os.Getenv("LINUXDO_CLIENT_ID"),
		LinuxDOClientSec: os.Getenv("LINUXDO_CLIENT_SECRET"),
		WelfareBaseURL:   strings.TrimRight(os.Getenv("WELFARE_BASE_URL"), "/"),
		WelfareJWTSecret: os.Getenv("WELFARE_JWT_SECRET"),
		WelfareSiteName:  strEnv("WELFARE_SITE_NAME", "福利站"),
		AdminLinuxDOIDs:  idSet(os.Getenv("WELFARE_ADMIN_LINUXDO_IDS")),
		MockOAuth:        strEnv("MOCK_OAUTH", "false") == "true",
	}

	quotaPerUnit, err1 := positiveInt64("QUOTA_PER_UNIT", os.Getenv("QUOTA_PER_UNIT"), 500000)
	maxGrant, err2 := positiveInt64("MAX_GRANT_QUOTA", os.Getenv("MAX_GRANT_QUOTA"), 5000000)
	cfg.QuotaPerUnit = quotaPerUnit
	cfg.MaxGrantQuota = maxGrant

	// WELFARE_JWT_SECRET must be >= 32 bytes.
	var errs []string
	if len(cfg.WelfareJWTSecret) < 32 {
		errs = append(errs, "WELFARE_JWT_SECRET must be at least 32 characters")
	}
	if err1 != "" {
		errs = append(errs, err1)
	}
	if err2 != "" {
		errs = append(errs, err2)
	}

	// Required in production, but allow missing when MOCK_OAUTH is enabled for
	// local development.
	required := []struct {
		name  string
		value string
		skip  bool
	}{
		{"NEWAPI_BASE_URL", cfg.NewAPIBaseURL, false},
		{"NEWAPI_ADMIN_PAT", cfg.NewAPIAdminPAT, false},
		{"LINUXDO_CLIENT_ID", cfg.LinuxDOClientID, true},
		{"LINUXDO_CLIENT_SECRET", cfg.LinuxDOClientSec, true},
		{"WELFARE_BASE_URL", cfg.WelfareBaseURL, true},
	}
	// DB_DSN is required for mysql; sqlite falls back to a local file for dev.
	if cfg.DBDriver == "sqlite" {
		if cfg.DBDSN == "" {
			cfg.DBDSN = "welfare_dev.db"
		}
	} else {
		cfg.DBDriver = "mysql"
		required = append(required, struct {
			name  string
			value string
			skip  bool
		}{"DB_DSN", cfg.DBDSN, false})
	}
	for _, r := range required {
		if r.skip && cfg.MockOAuth {
			continue
		}
		if strings.TrimSpace(r.value) == "" {
			errs = append(errs, r.name+" is required")
		}
	}

	if len(errs) > 0 {
		return nil, fmt.Errorf("missing/invalid required configuration:\n  - %s", strings.Join(errs, "\n  - "))
	}
	return cfg, nil
}

func strEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func positiveInt64(name, raw string, def int64) (int64, string) {
	if raw == "" {
		return def, ""
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, name + " must be a positive integer, got " + raw
	}
	return n, ""
}

func idSet(raw string) map[string]bool {
	m := make(map[string]bool)
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			m[p] = true
		}
	}
	return m
}

// IsAdminLinuxDO reports whether a LinuxDO id is in the admin whitelist.
func (c *Config) IsAdminLinuxDO(id string) bool {
	return c.AdminLinuxDOIDs[id]
}
