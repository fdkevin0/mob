package local

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/catalog"
	"github.com/fdkevin0/mob/internal/provider"
)

func TestProvidersReloadWhileRunning(t *testing.T) {
	for _, name := range []string{"MOB_CONFIG", "MOB_TOKEN", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_DEMO"} {
		t.Setenv(name, "")
	}
	dir := t.TempDir()
	offlineCatalog(t, dir)
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(fmt.Sprintf("data_dir: %q\naddr: 127.0.0.1:0\n", dir)), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_CONFIG", path)
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	app, err := Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	config := func() string {
		req, _ := http.NewRequest("GET", app.Connection.URL+"/api/config", nil)
		req.Header.Set("Authorization", "Bearer "+app.Connection.Token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var snapshot struct{ DefaultModel string }
		json.NewDecoder(resp.Body).Decode(&snapshot)
		return snapshot.DefaultModel
	}
	if got := config(); got != "opencode/mimo-v2.6-flash-free" {
		t.Fatalf("zero-configuration default %q", got)
	}
	providers := c.Loader.ProvidersPath()
	if err = provider.Save(providers, provider.File{Default: "work/m1", Providers: []provider.Provider{{ID: "work", Chat: "https://relay.example/v1", Key: "secret"}}}); err != nil {
		t.Fatal(err)
	}
	waitFor := func(ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); !ok(); time.Sleep(50 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("timed out")
			}
		}
	}
	waitFor(func() bool { return config() == "work/m1" })
	if err = os.WriteFile(providers, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	waitFor(func() bool { return strings.Contains(app.ConfigError(), "providers.json") })
	if got := config(); got != "work/m1" {
		t.Fatalf("broken file replaced providers: %q", got)
	}
}

func TestBackgroundShutdownAndUIAttachment(t *testing.T) {
	t.Setenv("MOB_TOKEN", "")
	c := Config{Dir: t.TempDir(), Addr: "127.0.0.1:0", Demo: true}
	app, err := StartDaemon(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Addr = strings.TrimPrefix(app.Connection.URL, "http://")
	_, closeUI, err := ConnectOrStart(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	closeUI()
	status, err := Status(c)
	if err != nil || !status.Background {
		t.Fatal("UI stopped background runtime")
	}
	closed := make(chan error, 1)
	go func() { <-app.Done; closed <- app.Close() }()
	if err = StopBackground(c); err != nil {
		t.Fatal(err)
	}
	if err = <-closed; err != nil {
		t.Fatal(err)
	}
	if _, err = Status(c); err == nil {
		t.Fatal("daemon still reachable")
	}
}

func TestDynamicConfigurationKeepsLastGoodAndStopsWatcher(t *testing.T) {
	for _, name := range []string{"MOB_CONFIG", "MOB_TOKEN", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_DEMO"} {
		t.Setenv(name, "")
	}
	dir := t.TempDir()
	offlineCatalog(t, dir)
	path := filepath.Join(dir, "config.yaml")
	body := func(addr string, demo bool) string {
		return fmt.Sprintf("data_dir: %q\nstate_dir: %q\naddr: %q\ndemo: %t\n", filepath.Join(dir, "data"), filepath.Join(dir, "state"), addr, demo)
	}
	write := func(raw string) {
		t.Helper()
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, path); err != nil {
			t.Fatal(err)
		}
	}
	write(body("127.0.0.1:0", true))
	t.Setenv("MOB_CONFIG", path)
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	app, err := Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	wait := func(check func() bool) {
		t.Helper()
		for deadline := time.Now().Add(4 * time.Second); !check(); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("configuration reload timed out")
			}
		}
	}
	write("demo: [fixture-private\n")
	wait(func() bool { return app.ConfigError() != "" })
	if strings.Contains(app.ConfigError(), "fixture-private") || app.Server.Providers.Default() != "demo/echo" {
		t.Fatal("invalid file changed state or leaked contents")
	}
	write(body("127.0.0.1:9999", true))
	wait(func() bool { return strings.Contains(app.ConfigError(), "restart") })
	write(body("127.0.0.1:0", false))
	wait(func() bool { return strings.Contains(app.ConfigError(), "demo changes require a restart") })
	write(body("127.0.0.1:0", true))
	wait(func() bool { return app.ConfigError() == "" })
	os.Remove(path)
	wait(func() bool { return app.ConfigError() != "" })
	write(body("127.0.0.1:0", true))
	wait(func() bool { return app.ConfigError() == "" })
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	write("demo: [after-close\n")
	time.Sleep(300 * time.Millisecond)
	if app.ConfigError() != "" {
		t.Fatal("watcher outlived runtime")
	}
}

// offlineCatalog keeps the running service from fetching models.dev.
func offlineCatalog(t *testing.T, dir string) {
	newCatalog = func() *catalog.Catalog { return &catalog.Catalog{Path: filepath.Join(dir, "models.json")} }
	url := catalog.URL
	catalog.URL = "http://127.0.0.1:1/unreachable"
	t.Cleanup(func() { newCatalog, catalog.URL = catalog.Default, url })
}
