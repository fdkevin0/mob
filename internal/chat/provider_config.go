package chat

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

func ValidateProviderURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("MOB_BASE_URL must be an HTTP(S) API base URL without credentials, query or fragment")
	}
	if u.Scheme == "https" {
		return nil
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())) {
		return nil
	}
	return errors.New("MOB_BASE_URL requires HTTPS except for localhost models")
}

// Empty base URLs refer to the default provider.
func ProviderOrigin(raw string) string {
	if raw == "" {
		raw = DefaultOpenCodeZenBaseURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}
