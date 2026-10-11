package configuration

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/adrg/xdg"
	"github.com/fdkevin0/mob/internal/chat"
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
	if got.Dir != defaultDataDir() || got.StateDir != filepath.Join(xdg.StateHome, "mob") || got.Provider.Model != chat.DefaultOpenCodeZenModel || got.Provider.APIKey != "" || got.KeySource != "" {
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

func TestLegacyKeysAndExplicitProviderOverrides(t *testing.T) {
	for _, tc := range []struct {
		name, config, mobKey, deepseekKey, baseURL, model string
		flags                                             []string
		wantURL, wantModel, wantKey                       string
	}{
		{name: "MOB key only", mobKey: "private", wantURL: "https://api.deepseek.com", wantModel: "deepseek-flash", wantKey: "private"},
		{name: "DeepSeek key only", deepseekKey: "private", wantURL: "https://api.deepseek.com", wantModel: "deepseek-flash", wantKey: "private"},
		{name: "file key only", config: "api_key: private\n", wantURL: "https://api.deepseek.com", wantModel: "deepseek-flash", wantKey: "private"},
		{name: "selected public key", mobKey: "public", deepseekKey: "private", wantURL: chat.DefaultOpenCodeZenBaseURL, wantModel: chat.DefaultOpenCodeZenModel, wantKey: "public"},
		{name: "environment endpoint", mobKey: "private", baseURL: chat.DefaultOpenCodeZenBaseURL, wantURL: chat.DefaultOpenCodeZenBaseURL, wantModel: chat.DefaultOpenCodeZenModel, wantKey: "private"},
		{name: "file endpoint", mobKey: "private", config: "base_url: https://opencode.ai/zen/v1\n", wantURL: chat.DefaultOpenCodeZenBaseURL, wantModel: chat.DefaultOpenCodeZenModel, wantKey: "private"},
		{name: "flag endpoint", mobKey: "private", flags: []string{"--base-url", chat.DefaultOpenCodeZenBaseURL}, wantURL: chat.DefaultOpenCodeZenBaseURL, wantModel: chat.DefaultOpenCodeZenModel, wantKey: "private"},
		{name: "environment model", deepseekKey: "private", model: chat.DefaultOpenCodeZenModel, wantURL: "https://api.deepseek.com", wantModel: chat.DefaultOpenCodeZenModel, wantKey: "private"},
		{name: "file model", deepseekKey: "private", config: "model: mimo-v2.6-flash-free\n", wantURL: "https://api.deepseek.com", wantModel: chat.DefaultOpenCodeZenModel, wantKey: "private"},
		{name: "flag model", deepseekKey: "private", flags: []string{"--model", chat.DefaultOpenCodeZenModel}, wantURL: "https://api.deepseek.com", wantModel: chat.DefaultOpenCodeZenModel, wantKey: "private"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cleanEnvironment(t)
			path := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(path, []byte(tc.config), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("MOB_CONFIG", path)
			t.Setenv("MOB_API_KEY", tc.mobKey)
			t.Setenv("DEEPSEEK_API_KEY", tc.deepseekKey)
			t.Setenv("MOB_BASE_URL", tc.baseURL)
			t.Setenv("MOB_MODEL", tc.model)
			flags := pflag.NewFlagSet("test", pflag.ContinueOnError)
			AddFlags(flags)
			if err := flags.Parse(tc.flags); err != nil {
				t.Fatal(err)
			}
			loader, err := NewLoader(flags)
			if err != nil {
				t.Fatal(err)
			}
			got, err := loader.Read()
			if err != nil {
				t.Fatal(err)
			}
			if got.Provider.BaseURL != tc.wantURL || got.Provider.Model != tc.wantModel || got.Provider.APIKey != tc.wantKey {
				t.Fatalf("incorrect provider selection: URL=%s model=%s", got.Provider.BaseURL, got.Provider.Model)
			}
		})
	}
}

func TestKeylessConfigPermissions(t *testing.T) {
	cleanEnvironment(t)
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("model: test\n"), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_CONFIG", path)
	for _, key := range []string{"", "environment-secret"} {
		t.Setenv("MOB_API_KEY", key)
		if _, err := Load(); err != nil {
			t.Fatalf("keyless config rejected: %v", err)
		}
	}
}
