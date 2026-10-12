package configuration

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/adrg/xdg"
	"github.com/fdkevin0/mob/internal/plugins/mcp"
	"github.com/fdkevin0/mob/internal/sandbox"
	"github.com/spf13/pflag"
)

func cleanEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"MOB_CONFIG", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_DEMO", "MOB_SANDBOX_ENABLED", "MOB_SANDBOX_RUNTIME", "MOB_SANDBOX_IMAGE", "MOB_SANDBOX_NETWORK", "MOB_SANDBOX_CPUS", "MOB_SANDBOX_MEMORY", "MOB_SANDBOX_ISOLATION", "MOB_MAX_TOOL_STEPS", "MOB_WEB_URL"} {
		t.Setenv(name, "")
	}
	// An empty MOB_WEB_URL turns the public web UI off, so it must be unset.
	os.Unsetenv("MOB_WEB_URL")
}
func TestConfigurationPrecedenceAndSafeReads(t *testing.T) {
	cleanEnvironment(t)
	path := filepath.Join(t.TempDir(), "config.yaml")
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("addr: 127.0.0.1:1001\ndemo: true\nsandbox:\n  enabled: true\n  runtime: apple\n")
	flags := pflag.NewFlagSet("test", pflag.ContinueOnError)
	AddFlags(flags)
	if err := flags.Parse([]string{"--config", path, "--addr", "127.0.0.1:1002", "--demo=false"}); err != nil {
		t.Fatal(err)
	}
	loader, err := NewLoader(flags)
	if err != nil {
		t.Fatal(err)
	}
	if loader.ProvidersPath() != filepath.Join(filepath.Dir(path), "providers.json") {
		t.Fatal("providers.json is not beside the configuration")
	}
	t.Setenv("MOB_ADDR", "127.0.0.1:1003")
	got, err := loader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got.Addr != "127.0.0.1:1002" || got.Demo || got.Sandbox != (sandbox.Settings{Enabled: true, Runtime: "apple", Image: sandbox.DefaultImage}) {
		t.Fatal("flags/environment precedence failed")
	}
	t.Setenv("MOB_SANDBOX_RUNTIME", "wslc")
	t.Setenv("MOB_SANDBOX_IMAGE", "alpine:3.20")
	if got, err = loader.Read(); err != nil || got.Sandbox.Runtime != "wslc" || got.Sandbox.Image != "alpine:3.20" {
		t.Fatal("sandbox settings not read from the environment")
	}
	t.Setenv("MOB_SANDBOX_RUNTIME", "")
	t.Setenv("MOB_SANDBOX_IMAGE", "")
	t.Setenv("MOB_SANDBOX_NETWORK", "none")
	t.Setenv("MOB_SANDBOX_CPUS", "2")
	t.Setenv("MOB_SANDBOX_MEMORY", "1g")
	if got, err = loader.Read(); err != nil || got.Sandbox.Network != "none" || got.Sandbox.CPUs != 2 || got.Sandbox.Memory != "1g" {
		t.Fatalf("sandbox limits not read from the environment: %+v %v", got.Sandbox, err)
	}
	t.Setenv("MOB_SANDBOX_NETWORK", "")
	t.Setenv("MOB_SANDBOX_CPUS", "")
	t.Setenv("MOB_SANDBOX_MEMORY", "")
	// gvisor needs containerd, so the file's apple runtime refuses it.
	t.Setenv("MOB_SANDBOX_ISOLATION", "gvisor")
	if _, err = loader.Read(); err == nil || !strings.Contains(err.Error(), "containerd") {
		t.Fatalf("gvisor accepted on apple: %v", err)
	}
	t.Setenv("MOB_SANDBOX_RUNTIME", "containerd")
	if got, err = loader.Read(); err != nil || got.Sandbox.Isolation != "gvisor" {
		t.Fatalf("sandbox isolation not read from the environment: %+v %v", got.Sandbox, err)
	}
	t.Setenv("MOB_SANDBOX_RUNTIME", "")
	t.Setenv("MOB_SANDBOX_ISOLATION", "")
	if got, err = loader.Read(); err != nil || got.MaxToolSteps != DefaultToolSteps {
		t.Fatalf("default tool steps: %d %v", got.MaxToolSteps, err)
	}
	t.Setenv("MOB_MAX_TOOL_STEPS", "40")
	if got, err = loader.Read(); err != nil || got.MaxToolSteps != 40 {
		t.Fatalf("tool steps not read from the environment: %d %v", got.MaxToolSteps, err)
	}
	for _, bad := range []string{"0", "101"} {
		t.Setenv("MOB_MAX_TOOL_STEPS", bad)
		if _, err = loader.Read(); err == nil || !strings.Contains(err.Error(), "max_tool_steps") {
			t.Fatalf("max_tool_steps %s accepted: %v", bad, err)
		}
	}
	t.Setenv("MOB_MAX_TOOL_STEPS", "")
	if got, err = loader.Read(); err != nil || got.WebURL != DefaultWebURL {
		t.Fatalf("default web_url: %q %v", got.WebURL, err)
	}
	t.Setenv("MOB_WEB_URL", "http://ftp.example/")
	if _, err = loader.Read(); err == nil || !strings.Contains(err.Error(), "web_url") {
		t.Fatalf("plain http web_url accepted: %v", err)
	}
	os.Unsetenv("MOB_WEB_URL")
	// Freeze parsed flags: later changes to a caller's FlagSet cannot alter the loader.
	flags.Set("addr", "127.0.0.1:1004")
	got, err = loader.Read()
	if err != nil || got.Addr != "127.0.0.1:1002" {
		t.Fatal("startup flags are mutable")
	}
	if runtime.GOOS != "windows" {
		os.Chmod(path, 0666)
		if _, err = loader.Read(); err == nil {
			t.Fatal("writable configuration allowed")
		}
		os.Chmod(path, 0600)
	}
	// Providers and keys live in providers.json; the old fields are refused.
	for _, body := range []string{"demo: [secret-invalid", "unknown_field: secret-unknown", "data_dir: ''", "api_key: secret-key", "base_url: https://example.org", "model: secret-model", "sandbox:\n  runtime: secret-docker", "sandbox:\n  image: --secret", "sandbox:\n  secret_field: 1", "sandbox:\n  network: secret-host", "sandbox:\n  cpus: -1", "sandbox:\n  memory: secret-512", "sandbox:\n  isolation: secret-kata", strings.Repeat("#", (64<<10)+1)} {
		write(body)
		_, err = loader.Read()
		if err == nil || strings.Contains(err.Error(), "secret-") {
			t.Fatalf("invalid config not safely rejected: %v", err)
		}
	}
	os.Remove(path)
	if _, err = loader.Read(); err == nil {
		t.Fatal("missing explicit file ignored")
	}
}

func TestXDGDefaultsAndOptionalFile(t *testing.T) {
	cleanEnvironment(t)
	// XDG exports are initialized at process startup; no global mutation is needed.
	loader, err := NewLoader(nil)
	if err != nil {
		t.Fatal(err)
	}
	if loader.Path() != filepath.Join(xdg.ConfigHome, "mob", "config.yaml") {
		t.Fatal("config is not in XDG config home")
	}
	loader.path = filepath.Join(t.TempDir(), "absent.yaml")
	got, err := loader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got.Dir != defaultDataDir() || got.StateDir != filepath.Join(xdg.StateHome, "mob") || got.Demo {
		t.Fatal("incorrect defaults")
	}
	target := filepath.Join(t.TempDir(), "target.yaml")
	os.WriteFile(target, []byte("demo: true"), 0600)
	if err = os.Symlink(target, loader.path); err == nil {
		if _, err = loader.Read(); err == nil {
			t.Fatal("symlink accepted")
		}
	}
}

func TestMCPServers(t *testing.T) {
	cleanEnvironment(t)
	path := filepath.Join(t.TempDir(), "config.yaml")
	write := func(body string) *Loader {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("MOB_CONFIG", path)
		loader, err := NewLoader(nil)
		if err != nil {
			t.Fatal(err)
		}
		return loader
	}
	got, err := write("mcp_servers:\n  github:\n    command: npx\n    args: [-y, server]\n    env: [GITHUB_TOKEN=x]\n  docs:\n    url: https://example.com/mcp\n    headers:\n      Authorization: Bearer y\n").Read()
	if err != nil {
		t.Fatal(err)
	}
	want := mcp.Servers{
		"github": {Command: "npx", Args: []string{"-y", "server"}, Env: []string{"GITHUB_TOKEN=x"}},
		"docs":   {URL: "https://example.com/mcp", Headers: map[string]string{"authorization": "Bearer y"}},
	}
	if !reflect.DeepEqual(got.MCPServers, want) {
		t.Fatalf("got %+v", got.MCPServers)
	}
	if _, err := write("mcp_servers:\n  both:\n    command: x\n    url: https://example.com\n").Read(); err == nil || !strings.Contains(err.Error(), "mcp_servers.both") {
		t.Fatalf("invalid server: %v", err)
	}
	if _, err := write("mcp_servers:\n  x:\n    command: x\n    unknown: 1\n").Read(); err == nil {
		t.Fatal("unknown server field accepted")
	}
}

func TestWebOrigin(t *testing.T) {
	for raw, want := range map[string]string{
		"":                             "",
		"https://mob.example":          "https://mob.example",
		"https://Mob.Example:443/app/": "https://mob.example",
		"https://mob.example:8443":     "https://mob.example:8443",
		"http://localhost:5173":        "http://localhost:5173",
		"http://127.0.0.1/":            "http://127.0.0.1",
		"http://[::1]:5173":            "http://[::1]:5173",
	} {
		if got, err := WebOrigin(raw); err != nil || got != want {
			t.Errorf("WebOrigin(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"http://mob.example", "ftp://mob.example", "https://", "mob.example", "https://user@mob.example", "https://mob.example/?q", "https://mob.example/#x", "https://mob.example/?"} {
		if _, err := WebOrigin(raw); err == nil {
			t.Errorf("WebOrigin(%q) accepted", raw)
		}
	}
}

func TestEmptyWebURLEnvironmentTurnsThePublicWebOff(t *testing.T) {
	cleanEnvironment(t)
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("web_url: https://mob.example\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_CONFIG", path)
	loader, err := NewLoader(nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := loader.Read(); err != nil || got.WebURL != "https://mob.example" {
		t.Fatalf("web_url from the file: %q %v", got.WebURL, err)
	}
	t.Setenv("MOB_WEB_URL", "")
	if got, err := loader.Read(); err != nil || got.WebURL != "" {
		t.Fatalf("empty MOB_WEB_URL kept %q: %v", got.WebURL, err)
	}
	t.Setenv("MOB_WEB_URL", "https://other.example")
	if got, err := loader.Read(); err != nil || got.WebURL != "https://other.example" {
		t.Fatalf("MOB_WEB_URL not read: %q %v", got.WebURL, err)
	}
}
