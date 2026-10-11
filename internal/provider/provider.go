// Package provider holds the model vendors Mob can reach: where each one
// lives, which protocols it speaks, the key the user entered, and which of its
// models they picked. Everything is in providers.json beside config.yaml,
// mode 0600. Keys are never read from environment variables: a provider is
// exactly what the user entered.
package provider

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/llm/demo"
)

type Protocol string

const (
	Chat      Protocol = "chat"      // OpenAI Chat Completions
	Anthropic Protocol = "anthropic" // Anthropic Messages
)

type Provider struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Preset string `json:"preset,omitempty"`
	Key    string `json:"key,omitempty"`
	// Base URLs, one per protocol the vendor serves; empty takes the preset's.
	Chat      string `json:"chat,omitempty"`
	Anthropic string `json:"anthropic,omitempty"`
	// ModelsURL is where the vendor lists its models, when not at the chat base.
	ModelsURL string `json:"modelsURL,omitempty"`
	// Models are the user's picks; none means every model the vendor lists.
	Models []string `json:"models,omitempty"`
	// PickedFrom is what the vendor listed when Models were saved: picks that
	// held all of it take in models listed since (see Picks).
	PickedFrom []string             `json:"pickedFrom,omitempty"`
	ModelPrefs map[string]ModelPref `json:"modelPrefs,omitempty"`
	Headers    map[string]string    `json:"headers,omitempty"`
	Off        bool                 `json:"off,omitempty"`
}

// ModelPref overrides what the catalog says of one model.
type ModelPref struct {
	Name      string    `json:"name,omitempty"`
	Context   int       `json:"context,omitempty"`
	Output    int       `json:"output,omitempty"`
	Reasoning *bool     `json:"reasoning,omitempty"`
	Tools     *bool     `json:"tools,omitempty"`
	Vision    *bool     `json:"vision,omitempty"`
	Efforts   []string  `json:"efforts,omitempty"`
	Cost      *llm.Cost `json:"cost,omitempty"`
	// API picks the protocol for a vendor serving several.
	API Protocol `json:"api,omitempty"`
}

// File is providers.json.
type File struct {
	// Default is the model a conversation uses until /model picks another.
	Default   string     `json:"default,omitempty"`
	Providers []Provider `json:"providers"`
}

// Initial is the zero-configuration file: OpenCode Zen's free tier.
func Initial() File {
	p := FindPreset("opencode")
	return File{Default: p.ID + "/" + p.Default, Providers: []Provider{{ID: p.ID, Preset: p.ID}}}
}

func (p Provider) preset() *Preset { return FindPreset(p.Preset) }

// Endpoint is the provider's base URL for a protocol, its own or its preset's.
func (p Provider) Endpoint(proto Protocol) string {
	own, preset := p.Chat, ""
	if proto == Anthropic {
		own = p.Anthropic
	}
	if pr := p.preset(); pr != nil {
		preset = pr.Chat
		if proto == Anthropic {
			preset = pr.Anthropic
		}
	}
	return cmp.Or(own, preset)
}

// Destination is where requests and their credentials go. A key or secret
// header saved for one destination must not follow a provider to another.
func (p Provider) Destination() string {
	return strings.Join([]string{p.Preset, p.Endpoint(Chat), p.Endpoint(Anthropic), p.ModelsURL}, "\x00")
}

// DisplayName is the provider's name, its preset's, or its ID.
func (p Provider) DisplayName() string {
	if p.Name != "" {
		return p.Name
	}
	if pr := p.preset(); pr != nil {
		return pr.Name
	}
	return p.ID
}

// MaskedKey shows enough of a key to recognize it.
func (p Provider) MaskedKey() string {
	switch {
	case p.Key == "":
		return ""
	case len(p.Key) <= 8:
		return "••••"
	default:
		return p.Key[:3] + "…" + p.Key[len(p.Key)-4:]
	}
}

// Public is the provider with its key and header values withheld, as the API
// and CLI show it.
func (p Provider) Public() Provider {
	p.Key = p.MaskedKey()
	if len(p.Headers) > 0 {
		h := make(map[string]string, len(p.Headers))
		for k := range p.Headers {
			h[k] = "••••"
		}
		p.Headers = h
	}
	return p
}

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ValidateURL accepts HTTPS, and HTTP only for loopback servers.
func ValidateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("must be an HTTP(S) API base URL without credentials, query or fragment")
	}
	if u.Scheme == "https" {
		return nil
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())) {
		return nil
	}
	return errors.New("requires HTTPS except for localhost servers")
}

func printable(s string, max int) bool {
	return len(s) <= max && !strings.ContainsFunc(s, func(r rune) bool { return r < 33 || r > 126 })
}

func (p Provider) Validate() error {
	fail := func(format string, args ...any) error {
		return fmt.Errorf("provider %q: %s", p.ID, fmt.Sprintf(format, args...))
	}
	if !idPattern.MatchString(p.ID) || p.ID == demo.ID {
		return fmt.Errorf("provider ID %q must be lowercase letters, digits, '.', '_' or '-' (and not %q)", p.ID, demo.ID)
	}
	if p.Preset != "" && p.preset() == nil {
		return fail("unknown preset %q", p.Preset)
	}
	if !printable(p.Key, 4096) {
		return fail("key must be printable ASCII without spaces")
	}
	if len(p.Name) > 100 || strings.ContainsAny(p.Name, "\r\n\x00") {
		return fail("invalid name")
	}
	for _, u := range []string{p.Chat, p.Anthropic, p.ModelsURL} {
		if u != "" {
			if err := ValidateURL(u); err != nil {
				return fail("URL %s", err)
			}
		}
	}
	if p.Endpoint(Chat) == "" && p.Endpoint(Anthropic) == "" {
		return fail("needs a chat or anthropic base URL")
	}
	for _, m := range append(slices.Clone(p.Models), p.PickedFrom...) {
		if m == "" || len(m) > 256 || strings.ContainsAny(m, "\r\n\x00 ") {
			return fail("invalid model ID %q", m)
		}
	}
	for m, pref := range p.ModelPrefs {
		if m == "" || len(m) > 256 || (pref.API != "" && pref.API != Chat && pref.API != Anthropic) {
			return fail("invalid model preference for %q", m)
		}
	}
	for k, v := range p.Headers {
		if k == "" || !printable(k, 256) || strings.ContainsAny(v, "\r\n\x00") || len(v) > 4096 {
			return fail("invalid header %q", k)
		}
	}
	return nil
}

func (f File) Validate() error {
	seen := map[string]bool{}
	for _, p := range f.Providers {
		if err := p.Validate(); err != nil {
			return err
		}
		if seen[p.ID] {
			return fmt.Errorf("provider %q is listed twice", p.ID)
		}
		seen[p.ID] = true
	}
	if f.Default != "" {
		if _, ok := llm.ParseRef(f.Default); !ok {
			return fmt.Errorf("default %q must be provider/model", f.Default)
		}
	}
	return nil
}

// Find returns the provider with the ID, or nil.
func (f File) Find(id string) *Provider {
	for i := range f.Providers {
		if f.Providers[i].ID == id {
			return &f.Providers[i]
		}
	}
	return nil
}

const maxFile = 1 << 20

// ErrUnreadable is a providers.json that exists but cannot be used. It is
// never taken for an empty list: saving over it would lose every provider.
var ErrUnreadable = errors.New("providers.json is unreadable")

// Load reads path; a missing file is the initial configuration.
func Load(path string) (File, error) {
	f, err := read(path)
	if errors.Is(err, os.ErrNotExist) {
		return Initial(), nil
	}
	return f, err
}

// read loads an existing providers.json; a missing file is an error
// wrapping os.ErrNotExist, never the initial configuration.
func read(path string) (File, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return File{}, fmt.Errorf("providers.json was removed: %w", err)
	}
	fail := func(reason string) (File, error) { return File{}, fmt.Errorf("%w: %s", ErrUnreadable, reason) }
	if err != nil {
		return fail(err.Error())
	}
	if !info.Mode().IsRegular() || info.Size() > maxFile {
		return fail("must be a regular file of at most 1 MiB")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return fail("it holds API keys and must be owner-only (chmod 600 " + path + ")")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fail("it changed while being read")
	}
	var f File
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err = d.Decode(&f); err != nil || d.Decode(new(any)) != io.EOF {
		return fail("invalid JSON or unknown field")
	}
	if err = f.Validate(); err != nil {
		return fail(err.Error())
	}
	return f, nil
}

// Save writes f atomically with owner-only permissions, keeping the file it
// replaces as providers.json.bak.
func Save(path string, f File) error {
	if err := f.Validate(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if old, err := os.ReadFile(path); err == nil {
		if err = os.WriteFile(path+".bak", old, 0600); err != nil {
			return err
		}
	}
	tmp, err := os.CreateTemp(dir, ".providers-*.json")
	if err != nil {
		return err
	}
	_, err = tmp.Write(append(raw, '\n'))
	err = errors.Join(err, tmp.Chmod(0600), tmp.Sync(), tmp.Close())
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}
