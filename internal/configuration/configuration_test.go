package configuration

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
)

func TestPluginSecretOwnership(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Service{Store: store}
	raw := `{"enabled":true,"accountId":"` + strings.Repeat("a", 32) + `","model":"@cf/chat","secrets":{"token":{"mode":"replace","value":"private-token"}}}`
	c, err := s.UpdatePlugin("cloudflare", []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(c.Public())
	if strings.Contains(string(public), "private-token") {
		t.Fatal("secret leaked")
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
	if _, err = s.UpdatePlugin("cloudflare", []byte(strings.Replace(raw, `"enabled":true`, `"enabled":true,"useForChat":true`, 1))); err == nil {
		t.Fatal("removed chat takeover field accepted")
	}
}
