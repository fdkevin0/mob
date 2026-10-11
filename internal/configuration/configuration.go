package configuration

import (
	"errors"
	"net/url"
	"strings"
	"sync"

	"github.com/fdkevin0/mob/internal/chat"
)

type Service struct {
	Store     *chat.Store
	Base      chat.Provider
	KeySource string
	mu        sync.Mutex
}
type Snapshot struct {
	Model      string `json:"model"`
	BaseURL    string `json:"baseURL"`
	Demo       bool   `json:"demo"`
	Configured bool   `json:"configured"`
	Source     string `json:"source"`
	KeySource  string `json:"keySource"`
}

func (s *Service) Effective() (chat.Provider, Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.effective(s.Base, s.KeySource)
}
func (s *Service) effective(base chat.Provider, keySource string) (chat.Provider, Snapshot, error) {
	p := base
	if keySource == "" {
		keySource = "saved"
		key, err := s.Store.APIKey()
		if err != nil {
			return p, Snapshot{}, err
		}
		if key != "" {
			p.APIKey, err = s.Store.APIKeyFor(p.BaseURL)
			if err != nil {
				return p, Snapshot{}, err
			}
		}
	}
	c, err := s.Plugins()
	if err != nil {
		return p, Snapshot{}, err
	}
	source := "default"
	if p.Demo {
		source = "demo"
	} else if c.Cloudflare.Enabled && c.Cloudflare.UseForChat {
		source = "cloudflare"
		p = chat.Provider{BaseURL: c.Cloudflare.BaseURL() + "/ai/v1", APIKey: c.Cloudflare.Token, Model: c.Cloudflare.Model, Transport: base.Transport}
		keySource = "saved"
	}
	if p.APIKey == "" && keySource == "saved" {
		if p.IsOpenCodeFreeTier() {
			p.APIKey = chat.DefaultOpenCodeZenKey
			keySource = "default"
		} else {
			keySource = "none"
		}
	}
	return p, Snapshot{Model: p.Model, BaseURL: p.BaseURL, Demo: p.Demo, Configured: p.Demo || p.APIKey != "", Source: source, KeySource: keySource}, nil
}

// ReplaceBase commits only a valid complete candidate. Never forward an existing
// credential to a new origin as a side effect of changing the endpoint.
func (s *Service) ReplaceBase(base chat.Provider, source string) (chat.Provider, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	oldURL, _ := url.Parse(s.Base.BaseURL)
	newURL, _ := url.Parse(base.BaseURL)
	if oldURL == nil || newURL == nil {
		return chat.Provider{}, errors.New("invalid provider URL")
	}
	if oldURL.Scheme != newURL.Scheme || !strings.EqualFold(oldURL.Host, newURL.Host) {
		oldKey := s.Base.APIKey
		if s.KeySource == "" {
			key, err := s.Store.APIKey()
			if err != nil {
				return chat.Provider{}, errors.New("cannot load saved configuration")
			}
			if key != "" {
				oldKey = key
			}
		}
		if oldKey != "" && (source == "" || base.APIKey == oldKey) {
			return chat.Provider{}, errors.New("changing API origin requires an explicit replacement credential or an explicit empty api_key")
		}
	}
	base.Transport = s.Base.Transport
	provider, _, err := s.effective(base, source)
	if err != nil {
		return chat.Provider{}, errors.New("cannot prepare effective configuration")
	}
	s.Base = base
	s.KeySource = source
	return provider, nil
}
func (s *Service) UpdateAPIKey(key, action string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.KeySource != "" {
		return &chat.CommandError{Status: 409, Message: "The API key is managed by runtime configuration."}
	}
	if action == "keep" {
		return nil
	}
	if action != "" && action != "replace" && action != "clear" {
		return errors.New("unknown API key action")
	}
	key = strings.TrimSpace(key)
	if action == "clear" {
		key = ""
	} else if key == "" || !validAPIKey(key) {
		return errors.New("Enter an API key without spaces or control characters.")
	}
	if err := s.Store.SaveAPIKeyFor(key, s.Base.BaseURL); err != nil {
		return err
	}
	s.Base.APIKey = key
	return nil
}
