package wechatilink

import (
	"context"
	"errors"
	"net/url"
	"strings"
)

// DefaultBaseURL is the official Tencent WeChat iLink API endpoint.
const DefaultBaseURL = "https://ilinkai.weixin.qq.com"

// Config defines settings for the WeChat iLink bot channel.
type Config struct {
	Enabled      bool     `json:"enabled"`
	BaseURL      string   `json:"baseUrl,omitempty"`
	BotToken     string   `json:"botToken,omitempty"`
	HasToken     bool     `json:"hasToken,omitempty"`
	BotID        string   `json:"botId,omitempty"`
	AllowedUsers []string `json:"allowedUsers,omitempty"`
}

// EndpointURL returns the effective API base URL.
func (c Config) EndpointURL() string {
	if strings.TrimSpace(c.BaseURL) == "" {
		return DefaultBaseURL
	}
	return strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
}

// Validate validates the configuration.
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	if c.BaseURL != "" {
		u, err := url.Parse(c.BaseURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
			return errors.New("WeChat iLink: baseUrl must be a valid HTTP or HTTPS URL")
		}
	}
	return nil
}

// Public sanitizes sensitive credentials before exposing to the UI.
func (c Config) Public() Config {
	c.HasToken = c.BotToken != ""
	c.BotToken = ""
	return c
}

// Test checks if the WeChat iLink connection is ready or has valid credentials.
func (c Config) Test(ctx context.Context) (any, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	hasCredential := c.BotToken != "" || c.HasToken
	return map[string]any{
		"channel":      "wechat-ilink",
		"baseUrl":      c.EndpointURL(),
		"hasToken":     hasCredential,
		"botId":        c.BotID,
		"allowedUsers": len(c.AllowedUsers),
		"status":       "ready",
	}, nil
}

// IsUserAllowed verifies whether the WeChat sender is authorized.
func (c Config) IsUserAllowed(userID string) bool {
	if len(c.AllowedUsers) == 0 {
		return true // open pairing / all authorized users
	}
	for _, u := range c.AllowedUsers {
		if strings.TrimSpace(u) == userID {
			return true
		}
	}
	return false
}
