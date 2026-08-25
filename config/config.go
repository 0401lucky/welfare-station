package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
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
	// 失败发放的自动重试(后台 worker):默认开启,每 60 秒扫一轮,单条最多自动重试 5 次。
	AutoRetryEnabled     bool
	AutoRetryInterval    time.Duration
	AutoRetryMaxAttempts int
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
		AutoRetryEnabled: boolEnv("AUTO_RETRY_ENABLED", true),
	}

	quotaPerUnit, err1 := positiveInt64("QUOTA_PER_UNIT", os.Getenv("QUOTA_PER_UNIT"), 500000)
	// MAX_GRANT_QUOTA 现在只是**首次运行的种子值**:落库后由后台「单次发放上限」接管
	// (service.GetGrantConfig)。默认 25000000 = $50(按 QUOTA_PER_UNIT=500000 折算)。
	maxGrant, err2 := positiveInt64("MAX_GRANT_QUOTA", os.Getenv("MAX_GRANT_QUOTA"), 25000000)
	cfg.QuotaPerUnit = quotaPerUnit
	cfg.MaxGrantQuota = maxGrant

	retryInterval, err3 := positiveInt64("AUTO_RETRY_INTERVAL_SECONDS", os.Getenv("AUTO_RETRY_INTERVAL_SECONDS"), 60)
	retryMax, err4 := positiveInt64("AUTO_RETRY_MAX_ATTEMPTS", os.Getenv("AUTO_RETRY_MAX_ATTEMPTS"), 5)
	cfg.AutoRetryInterval = time.Duration(retryInterval) * time.Second
	cfg.AutoRetryMaxAttempts = int(retryMax)

	// WELFARE_JWT_SECRET must be >= 32 bytes.
	var errs []string
	if len(cfg.WelfareJWTSecret) < 32 {
		errs = append(errs, "WELFARE_JWT_SECRET must be at least 32 characters")
	}
	for _, e := range []string{err1, err2, err3, err4} {
		if e != "" {
			errs = append(errs, e)
		}
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

// boolEnv 解析开关型环境变量,只有显式写 false/0/off 才关闭,未配置沿用默认值。
func boolEnv(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return def
	}
	return v != "false" && v != "0" && v != "off"
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
