package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
)

func TestSetupPersistsAndEnvironmentWins(t *testing.T) {
	t.Setenv("MOB_TOKEN", "")
	c := Config{Dir: t.TempDir(), Addr: "127.0.0.1:0", Provider: chat.Provider{Model: "test", BaseURL: "https://api.deepseek.com"}}
	app, err := Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if app != nil {
			app.Close()
		}
	}()
	request := func(method, body string, want int) string {
		t.Helper()
		req, _ := http.NewRequest(method, app.Connection.URL+"/api/config", bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+app.Connection.Token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != want {
			t.Fatalf("status %d: %s", resp.StatusCode, raw)
		}
		if strings.Contains(string(raw), "secret-key") {
			t.Fatal("key leaked")
		}
		return string(raw)
	}
	if !strings.Contains(request("GET", "", 200), `"configured":false`) {
		t.Fatal("missing setup")
	}
	request("POST", `{"apiKey":" "}`, 400)
	request("POST", `{"apiKey":"bad key"}`, 400)
	request("POST", `{"apiKey":"secret-key"}{}`, 400)
	if !strings.Contains(request("POST", `{"apiKey":"secret-key"}`, 200), `"configured":true`) {
		t.Fatal("not configured immediately")
	}
	app.Close()
	app = nil
	store, err := chat.OpenStore(filepath.Join(c.Dir, "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	key, err := store.APIKey()
	store.Close()
	if err != nil || key != "secret-key" {
		t.Fatal("key not persisted")
	}
	app, err = Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	var config struct{ Configured bool }
	json.Unmarshal([]byte(request("GET", "", 200)), &config)
	if !config.Configured {
		t.Fatal("restart lost config")
	}
	app.Close()
	app = nil
	c.Provider.APIKey = "environment-key"
	app, err = Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	request("POST", `{"apiKey":"replacement"}`, 409)
}

func TestBackgroundShutdownAndUIAttachment(t *testing.T) {
	t.Setenv("MOB_TOKEN", "")
	c := Config{Dir: t.TempDir(), Addr: "127.0.0.1:0", Provider: chat.Provider{Demo: true}}
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
	for _, name := range []string{"MOB_CONFIG", "MOB_TOKEN", "MOB_DATA_DIR", "MOB_STATE_DIR", "MOB_ADDR", "MOB_BASE_URL", "MOB_MODEL", "MOB_API_KEY", "DEEPSEEK_API_KEY", "MOB_DEMO"} {
		t.Setenv(name, "")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	body := func(model, addr string) string {
		return fmt.Sprintf("data_dir: %q\nstate_dir: %q\naddr: %q\nmodel: %q\ndemo: true\napi_key: fixture-private\n", filepath.Join(dir, "data"), filepath.Join(dir, "state"), addr, model)
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
	write(body("first", "127.0.0.1:0"))
	t.Setenv("MOB_CONFIG", path)
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	app, err := Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			app.Close()
		}
	}()
	wait := func(check func() bool) {
		t.Helper()
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			if check() {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("configuration reload timed out")
	}
	// Concurrent readers only ever observe complete validated snapshots.
	ctx, cancel := context.WithCancel(context.Background())
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		for ctx.Err() == nil {
			_, _, _ = app.Server.Configuration.Effective()
			time.Sleep(time.Millisecond)
		}
	}()
	defer func() { cancel(); <-joined }()
	write(body("second", "127.0.0.1:0"))
	wait(func() bool { return app.Server.Provider().Model == "second" })
	write("api_key: [fixture-private\n")
	wait(func() bool { return app.ConfigError() != "" })
	if app.Server.Provider().Model != "second" || strings.Contains(app.ConfigError(), "fixture-private") {
		t.Fatal("invalid file changed state or leaked credentials")
	}
	write(body("must-not-apply", "127.0.0.1:9999"))
	wait(func() bool { return strings.Contains(app.ConfigError(), "restart") })
	if app.Server.Provider().Model != "second" {
		t.Fatal("immutable setting rejection partially applied")
	}
	write(body("third", "127.0.0.1:0"))
	wait(func() bool { return app.Server.Provider().Model == "third" && app.ConfigError() == "" })
	os.Remove(path)
	wait(func() bool { return app.ConfigError() != "" })
	if app.Server.Provider().Model != "third" {
		t.Fatal("removed file reset config")
	}
	write(body("fourth", "127.0.0.1:0"))
	wait(func() bool { return app.Server.Provider().Model == "fourth" && app.ConfigError() == "" })
	cancel()
	<-joined
	// Avoid joining the same channel in the defer only blocks on an already closed channel.
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	write(body("after-close", "127.0.0.1:0"))
	if app.Server.Provider().Model != "fourth" {
		t.Fatal("watcher outlived runtime")
	}
}
