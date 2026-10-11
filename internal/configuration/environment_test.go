package configuration

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/adrg/xdg"
	"github.com/spf13/pflag"
)

func cleanEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"MOB_CONFIG", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_DEMO", "MOB_CONTAINER_RUNTIME"} {
		t.Setenv(name, "")
	}
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
	write("addr: 127.0.0.1:1001\ndemo: true\ncontainer_runtime: apple\n")
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
	if got.Addr != "127.0.0.1:1002" || got.Demo || got.ContainerRuntime != "apple" {
		t.Fatal("flags/environment precedence failed")
	}
	t.Setenv("MOB_CONTAINER_RUNTIME", "wslc")
	if got, err = loader.Read(); err != nil || got.ContainerRuntime != "wslc" {
		t.Fatal("container runtime not read from the environment")
	}
	t.Setenv("MOB_CONTAINER_RUNTIME", "")
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
	for _, body := range []string{"demo: [secret-invalid", "unknown_field: secret-unknown", "data_dir: ''", "api_key: secret-key", "base_url: https://example.org", "model: secret-model", "container_runtime: secret-docker", strings.Repeat("#", (64<<10)+1)} {
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
