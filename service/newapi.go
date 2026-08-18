package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// NewAPIUser mirrors the fields of the new-api user object returned by the
// AdminAuth endpoints (design.md §4.1 / §4.3).
type NewAPIUser struct {
	ID             int64  `json:"id"`
	Username       string `json:"username"`
	DisplayName    string `json:"display_name"`
	LinuxDOID      string `json:"linux_do_id"`
	Quota          int64  `json:"quota"`
	TemporaryQuota int64  `json:"temporary_quota"`
	Status         int    `json:"status"`
	Role           int    `json:"role"`
}

// newAPIEnvelope is the shared response wrapper `{success, message, data}`.
type newAPIEnvelope struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// NewAPIClient talks to the new-api instance over HTTP using an admin PAT.
// The sole sensitive config (NEWAPI_ADMIN_PAT) is kept here and never logged.
type NewAPIClient struct {
	baseURL string
	pat     string
	http    *http.Client
}

func NewNewAPIClient(baseURL, pat string) *NewAPIClient {
	return &NewAPIClient{
		baseURL: baseURL,
		pat:     pat,
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *NewAPIClient) do(method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.pat)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("new-api unreachable: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read new-api response: %w", err)
	}

	var env newAPIEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("new-api returned non-JSON (HTTP %d)", resp.StatusCode)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !env.Success {
		msg := env.Message
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return errors.New(msg)
	}

	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("decode new-api data: %w", err)
		}
	}
	return nil
}

// GetUserByLinuxDOId is design.md §4.1: exact reverse lookup by linux_do_id.
func (c *NewAPIClient) GetUserByLinuxDOId(linuxDOID string) (*NewAPIUser, error) {
	var u NewAPIUser
	err := c.do(http.MethodGet, "/api/user/by_linuxdo?linux_do_id="+url.QueryEscape(linuxDOID), nil, &u)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// GetUser is design.md §4.3: fetch a user by new-api id.
func (c *NewAPIClient) GetUser(newapiUserID int64) (*NewAPIUser, error) {
	var u NewAPIUser
	path := fmt.Sprintf("/api/user/%d", newapiUserID)
	if err := c.do(http.MethodGet, path, nil, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// AddQuota is design.md §4.2: the single payout channel. value must be > 0.
func (c *NewAPIClient) AddQuota(newapiUserID, value int64) error {
	if value <= 0 {
		return errors.New("quota value must be positive")
	}
	body := map[string]any{
		"id":     newapiUserID,
		"action": "add_quota",
		"mode":   "add",
		"value":  value,
	}
	return c.do(http.MethodPost, "/api/user/manage", body, nil)
}
