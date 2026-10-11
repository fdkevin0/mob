package configuration

import (
	"encoding/json"
	"github.com/fdkevin0/mob/internal/chat"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecretOwnershipAndEffectiveProvider(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Service{Store: store, Base: chat.Provider{Model: "default", APIKey: "fallback"}}
	raw := `{"enabled":true,"useForChat":true,"accountId":"` + strings.Repeat("a", 32) + `","model":"@cf/chat","secrets":{"token":{"mode":"replace","value":"private-token"}}}`
	c, err := s.UpdatePlugin("cloudflare", []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(c.Public())
	if strings.Contains(string(public), "private-token") {
		t.Fatal("secret leaked")
	}
	p, snapshot, err := s.Effective()
	if err != nil || p.APIKey != "private-token" || snapshot.Source != "cloudflare" {
		t.Fatalf("effective: %+v %v", snapshot, err)
	}
	moved := strings.ReplaceAll(strings.ReplaceAll(raw, strings.Repeat("a", 32), strings.Repeat("b", 32)), `"mode":"replace","value":"private-token"`, `"mode":"keep"`)
	if _, err = s.UpdatePlugin("cloudflare", []byte(moved)); err == nil {
		t.Fatal("credential followed account change")
	}
	clear := strings.ReplaceAll(strings.ReplaceAll(raw, `"enabled":true`, `"enabled":false`), `"mode":"replace","value":"private-token"`, `"mode":"clear"`)
	c, err = s.UpdatePlugin("cloudflare", []byte(clear))
	if err != nil || c.Cloudflare.Token != "" {
		t.Fatalf("clear: %v", err)
	}
	p, snapshot, err = s.Effective()
	if err != nil || p.APIKey != "fallback" || snapshot.Source != "default" {
		t.Fatal("fallback lost")
	}
	if err = s.UpdateAPIKey("saved", "replace"); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateAPIKey("", "clear"); err != nil {
		t.Fatal(err)
	}
	_, snapshot, err = s.Effective()
	if err != nil || snapshot.Configured {
		t.Fatal("clear retained key")
	}
	s.KeySource = "environment"
	s.Base.APIKey = "env"
	if err = s.UpdateAPIKey("", "clear"); err == nil {
		t.Fatal("environment key editable")
	}
	if _, err = s.UpdatePlugin("cloudflare", []byte(raw)); err != nil {
		t.Fatal(err)
	}
	s.Base.Demo = true
	_, snapshot, err = s.Effective()
	if err != nil || snapshot.Source != "demo" {
		t.Fatal("demo failed to override cloud")
	}
}

func TestReloadRejectsCredentialOriginChangeAtomically(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.SaveAPIKey("saved-private")
	service := &Service{Store: store, Base: chat.Provider{BaseURL: "https://api.deepseek.com", Model: "old"}}
	next := chat.Provider{BaseURL: "https://other.example", Model: "new"}
	if _, err = service.ReplaceBase(next, ""); err == nil {
		t.Fatal("forwarded saved key to different origin")
	}
	current, _, err := service.Effective()
	if err != nil || current.Model != "old" || current.APIKey != "saved-private" {
		t.Fatal("rejected candidate changed state")
	}
	next.APIKey = "replacement"
	current, err = service.ReplaceBase(next, "file")
	if err != nil || current.Model != "new" || current.APIKey != "replacement" {
		t.Fatal("valid replacement failed")
	}
	if err = service.UpdateAPIKey("replacement-via-ui", "replace"); err == nil {
		t.Fatal("file-managed key editable via UI")
	}
	next.BaseURL = "https://third.example"
	next.APIKey = ""
	current, err = service.ReplaceBase(next, "file")
	if err != nil || current.APIKey != "" {
		t.Fatal("explicit clear used saved key")
	}
}

func TestSavedCredentialRemainsScopedAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mob.sqlite")
	store, err := chat.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{Store: store, Base: chat.Provider{BaseURL: "https://first.example", Model: "test"}}
	if err = service.UpdateAPIKey("scoped-secret", "replace"); err != nil {
		t.Fatal(err)
	}
	store.Close()
	store, err = chat.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service = &Service{Store: store, Base: chat.Provider{BaseURL: "https://second.example", Model: "test"}}
	provider, _, err := service.Effective()
	if err != nil || provider.APIKey != "" {
		t.Fatal("saved key escaped origin after restart")
	}
	service.Base.BaseURL = "https://first.example/v1"
	provider, _, err = service.Effective()
	if err != nil || provider.APIKey != "scoped-secret" {
		t.Fatal("same-origin key lost")
	}
}
