package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
