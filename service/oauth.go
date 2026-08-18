package service

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OAuth endpoints verified in new-api's oauth/linuxdo.go (design.md §6).
const (
	LinuxDOAuthorizeURL = "https://connect.linux.do/oauth2/authorize"
	LinuxDOTokenURL     = "https://connect.linux.do/oauth2/token"
	LinuxDOUserURL      = "https://connect.linux.do/api/user"
)

// OAuthUser mirrors the LinuxDO /api/user payload.
type OAuthUser struct {
	ID         int    `json:"id"`
	Username   string `json:"username"`
	Name       string `json:"name"`
	Active     bool   `json:"active"`
	TrustLevel int    `json:"trust_level"`
	Silenced   bool   `json:"silenced"`
}

// LinuxDOClient performs the OAuth authorization-code flow (design.md §6).
type LinuxDOClient struct {
	clientID     string
	clientSecret string
	callbackURL  string
	http         *http.Client
}

func NewLinuxDOClient(clientID, clientSecret, welfareBaseURL string) *LinuxDOClient {
	return &LinuxDOClient{
		clientID:     clientID,
		clientSecret: clientSecret,
		callbackURL:  welfareBaseURL + "/api/oauth/linuxdo/callback",
		http:         &http.Client{Timeout: 10 * time.Second},
	}
}

func (l *LinuxDOClient) AuthorizeURL(state string) string {
	q := url.Values{}
	q.Set("client_id", l.clientID)
	q.Set("response_type", "code")
	q.Set("state", state)
	q.Set("redirect_uri", l.callbackURL)
	return LinuxDOAuthorizeURL + "?" + q.Encode()
}

// ExchangeCode trades an authorization code for an access token.
func (l *LinuxDOClient) ExchangeCode(code string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", l.callbackURL)

	req, err := http.NewRequest(http.MethodPost, LinuxDOTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// Basic auth: base64(client_id:client_secret)
	basic := base64.StdEncoding.EncodeToString([]byte(l.clientID + ":" + l.clientSecret))
	req.Header.Set("Authorization", "Basic "+basic)

	resp, err := l.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("LinuxDO token endpoint unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", errors.New("LinuxDO token response not JSON")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || tokenResp.AccessToken == "" {
		return "", errors.New("LinuxDO token error: " + tokenResp.Error)
	}
	return tokenResp.AccessToken, nil
}

// FetchUser loads the current LinuxDO user record.
func (l *LinuxDOClient) FetchUser(accessToken string) (*OAuthUser, error) {
	req, err := http.NewRequest(http.MethodGet, LinuxDOUserURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := l.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("LinuxDO user endpoint unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("LinuxDO user endpoint returned HTTP %d", resp.StatusCode)
	}

	var u OAuthUser
	if err := json.Unmarshal(body, &u); err != nil {
		return nil, errors.New("LinuxDO user response not JSON")
	}
	return &u, nil
}

// Now helper for callback URL (used in logs/tests).
func (l *LinuxDOClient) CallbackURL() string { return l.callbackURL }

// stateStore holds short-lived OAuth states (5-minute TTL) in memory. A single
// instance serves all users; states are single-use and discarded after check.
type stateStore struct {
	values map[string]time.Time
	ttl    time.Duration
}

func newStateStore(ttl time.Duration) *stateStore {
	return &stateStore{values: make(map[string]time.Time), ttl: ttl}
}

// Put records a state. If the store is full it evicts expired entries.
func (s *stateStore) Put(state string) {
	now := time.Now()
	s.evict(now)
	s.values[state] = now.Add(s.ttl)
}

// Check validates and consumes a state; a state can only be used once.
func (s *stateStore) Check(state string) bool {
	now := time.Now()
	s.evict(now)
	exp, ok := s.values[state]
	if !ok {
		return false
	}
	delete(s.values, state) // single-use
	return now.Before(exp)
}

func (s *stateStore) evict(now time.Time) {
	for k, exp := range s.values {
		if now.After(exp) {
			delete(s.values, k)
		}
	}
}

var oauthStates = newStateStore(5 * time.Minute)

// PutOAuthState stores a freshly generated state for later verification.
func PutOAuthState(state string) {
	oauthStates.Put(state)
}

// ConsumeOAuthState validates and single-uses a callback state.
func ConsumeOAuthState(state string) bool {
	return oauthStates.Check(state)
}
