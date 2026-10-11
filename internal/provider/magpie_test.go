package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/catalog"
	"github.com/fdkevin0/mob/internal/llm"
)

// magpieAt has magpie's settings name server's port.
func magpieAt(t *testing.T, server *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	u, _ := url.Parse(server.URL)
	if err := os.MkdirAll(filepath.Join(dir, "magpie"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "magpie", "settings.json"), []byte(`{"port":`+u.Port()+`,"theme":"dark"}`), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestMagpie(t *testing.T) {
	var keys []string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/hello":
			json.NewEncoder(w).Encode(map[string]string{"name": "magpie", "version": "1"})
			return
		case "/v1/models":
			keys = append(keys, r.Header.Get("Authorization"))
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "gpt-6"}, {"id": "claude-sonnet-5"}}})
			return
		}
		keys = append(keys, r.Header.Get("Authorization")+r.Header.Get("x-api-key"))
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(gateway.Close)
	magpieAt(t, gateway)

	chat, anthropic, err := FindMagpie(context.Background(), nil)
	if err != nil || chat != gateway.URL+"/v1" || anthropic != gateway.URL {
		t.Fatalf("found %s %s: %v", chat, anthropic, err)
	}
	r, err := Open("", &catalog.Catalog{}, File{Providers: []Provider{{ID: "magpie", Preset: "magpie", Chat: chat, Anthropic: anthropic}}})
	if err != nil {
		t.Fatal(err)
	}
	if g := r.List(context.Background(), ""); len(g) != 1 || len(g[0].Models) != 2 || g[0].Name != "Magpie" {
		t.Fatalf("models: %+v", g)
	}
	m, err := r.Resolve("magpie/gpt-6")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Stream(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Text: "hi"}}}, func(string, string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	// Without a key of the user's, magpie is told the calls are Mob's.
	if strings.Join(keys, ",") != "Bearer magpie-mob,Bearer magpie-mob" {
		t.Fatalf("keys: %v", keys)
	}
}

func TestMagpieNotFound(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"name": "something else"})
	}))
	t.Cleanup(other.Close)
	magpieAt(t, other)
	if _, _, err := FindMagpie(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "is not magpie") {
		t.Fatalf("took another server for magpie: %v", err)
	}
	other.Close()
	if _, _, err := FindMagpie(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("found a stopped magpie: %v", err)
	}
}

func TestMagpieDefaultAddress(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	p := FindPreset("magpie")
	if want := magpieAddress(); p.Chat != want+"/v1" || p.Anthropic != want {
		t.Fatalf("the preset is not at magpie's default address %s: %+v", want, p)
	}
}
