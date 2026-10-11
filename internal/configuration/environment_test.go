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
	for _, name := range []string{"MOB_CONFIG", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_BASE_URL", "MOB_MODEL", "MOB_API_KEY", "DEEPSEEK_API_KEY", "MOB_DEMO"} {
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
	write("model: from-file\napi_key: secret-file\ndemo: true\n")
	flags := pflag.NewFlagSet("test", pflag.ContinueOnError)
	AddFlags(flags)
	if err := flags.Parse([]string{"--config", path, "--model", "from-flag", "--demo=false"}); err != nil {
		t.Fatal(err)
	}
	loader, err := NewLoader(flags)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_MODEL", "from-env")
	t.Setenv("MOB_API_KEY", "secret-env")
	t.Setenv("DEEPSEEK_API_KEY", "secret-fallback")
	got, err := loader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got.Provider.Model != "from-flag" || got.Provider.Demo || got.Provider.APIKey != "secret-env" || got.KeySource != "environment" {
		t.Fatal("flags/environment precedence failed")
	}
	// Freeze parsed flags: later changes to a caller's FlagSet cannot alter the loader.
	flags.Set("model", "changed-after-start")
	got, err = loader.Read()
	if err != nil || got.Provider.Model != "from-flag" {
		t.Fatal("startup flags are mutable")
	}
	t.Setenv("MOB_API_KEY", "")
	got, err = loader.Read()
	if err != nil || got.Provider.APIKey != "secret-fallback" {
		t.Fatal("DeepSeek fallback failed")
	}
	t.Setenv("DEEPSEEK_API_KEY", "")
	got, err = loader.Read()
	if err != nil || got.Provider.APIKey != "secret-file" || got.KeySource != "file" {
		t.Fatal("file key missing")
	}
	if runtime.GOOS != "windows" {
		os.Chmod(path, 0644)
		if _, err = loader.Read(); err == nil || strings.Contains(err.Error(), "secret-file") {
			t.Fatal("unsafe secret file allowed or error leaked secret")
		}
		os.Chmod(path, 0600)
	}
	for _, body := range []string{"api_key: [secret-invalid", "unknown_field: secret-unknown", "addr: 0.0.0.0:8787", "base_url: https://user:secret-url@example.org", "api_key: bad secret-key", strings.Repeat("#", (64<<10)+1)} {
		write(body)
		_, err = loader.Read()
		if err == nil || strings.Contains(err.Error(), "secret-") {
			t.Fatalf("invalid config not safely rejected: %v", err)
		}
	}
	write("api_key: ''\n")
	got, err = loader.Read()
	if err != nil || got.KeySource != "file" || got.Provider.APIKey != "" {
		t.Fatal("explicit empty file key lost")
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
	if got.Dir != defaultDataDir() || got.StateDir != filepath.Join(xdg.StateHome, "mob") || got.Provider.Model != "deepseek-flash" {
		t.Fatal("incorrect defaults")
	}
	target := filepath.Join(t.TempDir(), "target.yaml")
	os.WriteFile(target, []byte("model: test"), 0600)
	if err = os.Symlink(target, loader.path); err == nil {
		if _, err = loader.Read(); err == nil {
			t.Fatal("symlink accepted")
		}
	}
}
