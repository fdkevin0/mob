package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/provider"
)

func TestProviderCommands(t *testing.T) {
	for _, name := range []string{"MOB_CONFIG", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_DEMO"} {
		t.Setenv(name, "")
	}
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-from-stdin-1234" {
			w.WriteHeader(401)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "m1"}, {"id": "m2"}}})
	}))
	defer vendor.Close()
	dir := t.TempDir()
	config := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(config, []byte("demo: false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(stdin string, args ...string) (string, error) {
		t.Helper()
		command := newRootCommand()
		var out bytes.Buffer
		command.SetOut(&out)
		command.SetErr(&out)
		command.SetIn(strings.NewReader(stdin))
		command.SetArgs(append(args, "--config", config))
		err := command.Execute()
		return out.String(), err
	}
	if _, err := run("", "provider", "add", "unknown-vendor"); err == nil {
		t.Fatal("custom provider without URL accepted")
	}
	if _, err := run("", "provider", "add", "deepseek", "--offline"); err == nil || !strings.Contains(err.Error(), "needs an API key") {
		t.Fatalf("keyless preset: %v", err)
	}
	out, err := run("sk-from-stdin-1234\n", "provider", "add", "work", "--chat", vendor.URL, "--key-stdin", "--models", "m1", "--default", "m1")
	if err != nil || !strings.Contains(out, "Added work") || !strings.Contains(out, "lists 2 models") {
		t.Fatalf("%s %v", out, err)
	}
	path := filepath.Join(dir, "providers.json")
	f, err := provider.Load(path)
	if err != nil || f.Default != "work/m1" || f.Find("work").Key != "sk-from-stdin-1234" || strings.Join(f.Find("work").PickedFrom, ",") != "m1,m2" || f.Find("opencode") == nil {
		t.Fatalf("saved %+v %v", f, err)
	}
	if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("providers.json is not owner-only")
	}
	out, err = run("", "provider", "ls")
	if err != nil || !strings.Contains(out, "work") || !strings.Contains(out, "sk-…1234") || strings.Contains(out, "sk-from-stdin") || !strings.Contains(out, "Default model: work/m1") {
		t.Fatalf("ls %s %v", out, err)
	}
	// Updating keeps what was not given, including the key.
	if out, err = run("", "provider", "add", "work", "--name", "Work relay", "--offline"); err != nil || !strings.Contains(out, "Updated work") {
		t.Fatalf("%s %v", out, err)
	}
	if f, _ = provider.Load(path); f.Find("work").Key != "sk-from-stdin-1234" || f.Find("work").Name != "Work relay" {
		t.Fatalf("update %+v", f.Find("work"))
	}
	// A new destination never receives the old credentials.
	var leaked int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Team") != "" {
			leaked++
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "m3"}}})
	}))
	defer other.Close()
	if _, err = run("", "provider", "add", "work", "--chat", other.URL); err == nil || !strings.Contains(err.Error(), "--clear-key") {
		t.Fatalf("key followed the endpoint: %v", err)
	}
	f, _ = provider.Load(path)
	f.Find("work").Headers = map[string]string{"X-Team": "team-secret"}
	if err = provider.Save(path, f); err != nil {
		t.Fatal(err)
	}
	if _, err = run("", "provider", "add", "work", "--chat", other.URL, "--clear-key"); err == nil || !strings.Contains(err.Error(), "--clear-headers") {
		t.Fatalf("headers followed the endpoint: %v", err)
	}
	if _, err = run("", "provider", "add", "work", "--chat", other.URL, "--clear-key", "--clear-headers"); err != nil {
		t.Fatal(err)
	}
	if f, _ = provider.Load(path); f.Find("work").Key != "" || f.Find("work").Headers != nil || leaked != 0 {
		t.Fatalf("credentials kept or sent: %+v, %d leaks", f.Find("work"), leaked)
	}
	if out, err = run("", "provider", "rm", "work"); err != nil || !strings.Contains(out, "held the default") {
		t.Fatalf("%s %v", out, err)
	}
	if f, _ = provider.Load(path); f.Find("work") != nil || f.Default != "" {
		t.Fatalf("rm %+v", f)
	}
	if _, err = run("", "provider", "rm", "work"); err == nil {
		t.Fatal("removing a missing provider succeeded")
	}
}

func TestProviderAddMagpie(t *testing.T) {
	for _, name := range []string{"MOB_CONFIG", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_DEMO"} {
		t.Setenv(name, "")
	}
	var keys []string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/hello" {
			json.NewEncoder(w).Encode(map[string]string{"name": "magpie"})
			return
		}
		keys = append(keys, r.Header.Get("Authorization"))
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "gpt-6"}}})
	}))
	defer gateway.Close()
	magpie := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", magpie)
	u, _ := url.Parse(gateway.URL)
	os.MkdirAll(filepath.Join(magpie, "magpie"), 0700)
	if err := os.WriteFile(filepath.Join(magpie, "magpie", "settings.json"), []byte(`{"port":`+u.Port()+`}`), 0600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	config := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(config, []byte("demo: false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		command := newRootCommand()
		var out bytes.Buffer
		command.SetOut(&out)
		command.SetErr(&out)
		command.SetIn(strings.NewReader(""))
		command.SetArgs(append(args, "--config", config))
		err := command.Execute()
		return out.String(), err
	}
	out, err := run("provider", "add", "magpie")
	if err != nil || !strings.Contains(out, "Added magpie (Magpie)") || !strings.Contains(out, "lists 1 models") {
		t.Fatalf("%s %v", out, err)
	}
	f, err := provider.Load(filepath.Join(dir, "providers.json"))
	if p := f.Find("magpie"); err != nil || p == nil || p.Chat != gateway.URL+"/v1" || p.Anthropic != gateway.URL || p.Key != "" {
		t.Fatalf("saved %+v %v", p, err)
	}
	if strings.Join(keys, ",") != "Bearer magpie-mob" {
		t.Fatalf("keys: %v", keys)
	}
	gateway.Close()
	if _, err = run("provider", "add", "magpie"); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("added a magpie that is not running: %v", err)
	}
	if _, err = run("provider", "add", "magpie", "--offline"); err != nil {
		t.Fatal(err)
	}
}
