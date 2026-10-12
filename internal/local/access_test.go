package local

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/app"
)

func TestRotateTokenAndPairingURL(t *testing.T) {
	t.Setenv("MOB_TOKEN", "")
	c := Config{Dir: t.TempDir(), Addr: "127.0.0.1:0", Demo: true}
	token := func() string {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(c.Dir, "token"))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	// Not running: only the file changes, and pairing needs the service.
	if err := os.WriteFile(filepath.Join(c.Dir, "token"), []byte(strings.Repeat("a", 64)), 0600); err != nil {
		t.Fatal(err)
	}
	c.Addr = "127.0.0.1:1"
	if err := RotateToken(c); err != nil {
		t.Fatal(err)
	}
	if got := token(); got == strings.Repeat("a", 64) || len(got) != 64 {
		t.Fatalf("offline rotation wrote %q", got)
	}
	if info, _ := os.Stat(filepath.Join(c.Dir, "token")); info.Mode().Perm() != 0600 {
		t.Fatalf("token file mode %v", info.Mode().Perm())
	}
	if _, err := PairingURL(c); err == nil {
		t.Fatal("pairing without a running service")
	}

	c.Addr = "127.0.0.1:0"
	running, err := Start(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer running.Close()
	c.Addr = strings.TrimPrefix(running.Connection.URL, "http://")
	link, err := PairingURL(c)
	if err != nil || !strings.HasPrefix(link, running.Connection.URL+"/#pair=") {
		t.Fatalf("pairing link %q %v", link, err)
	}
	if _, err = WebURL(c); err == nil {
		t.Fatal("web link without web_url")
	}
	c.WebURL = "https://mob.example/"
	link, err = WebURL(c)
	encoded, found := strings.CutPrefix(link, "https://mob.example/#offer=")
	if err != nil || !found {
		t.Fatalf("web link %q %v", link, err)
	}
	var offer Offer
	if raw, err := base64.RawURLEncoding.DecodeString(encoded); err != nil || json.Unmarshal(raw, &offer) != nil || offer.Version != 1 || offer.URL != running.Connection.URL || offer.Code == "" {
		t.Fatalf("offer %q: %+v %v", encoded, offer, err)
	}
	claim, err := http.Post(offer.URL+"/api/pairing/claim", "application/json", strings.NewReader(`{"code":"`+offer.Code+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	var claimed struct{ Token string }
	if json.NewDecoder(claim.Body).Decode(&claimed); claim.Body.Close() != nil || claimed.Token != running.Server.Token() {
		t.Fatalf("offer code claimed %d", claim.StatusCode)
	}
	old := running.Server.Token()
	if err = RotateToken(c); err != nil {
		t.Fatal(err)
	}
	if now := running.Server.Token(); now == old || token() != now {
		t.Fatal("running service and token file disagree after rotation")
	}
	if Reachable(Connection{URL: running.Connection.URL, Token: old}) {
		t.Fatal("old token still accepted")
	}

	// A token file that no longer matches the running service is an error, never
	// an offline rotation that would leave the two disagreeing.
	live := running.Server.Token()
	stale := strings.Repeat("s", 64)
	if err = os.WriteFile(filepath.Join(c.Dir, "token"), []byte(stale), 0600); err != nil {
		t.Fatal(err)
	}
	if err = RotateToken(c); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("stale token file: %v", err)
	}
	if token() != stale || running.Server.Token() != live {
		t.Fatal("rotation with a stale token file changed the file or the service")
	}

	t.Setenv("MOB_TOKEN", strings.Repeat("e", 32))
	if err = RotateToken(c); !errors.Is(err, app.ErrTokenFromEnvironment) {
		t.Fatalf("MOB_TOKEN rotation: %v", err)
	}
}

func TestOfflineRotationIsSerializedWithStartup(t *testing.T) {
	t.Setenv("MOB_TOKEN", "")
	c := Config{Dir: t.TempDir(), Addr: "127.0.0.1:0", Demo: true}
	if err := writeToken(c.Dir, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	// An offline rotation holds the token lock; a service starting meanwhile
	// waits and then reads the replacement, never the token being replaced.
	unlock, err := lockToken(c.Dir)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan *App, 1)
	go func() {
		app, err := Start(c, nil)
		if err != nil {
			t.Error(err)
		}
		started <- app
	}()
	select {
	case <-started:
		t.Fatal("service read the token while it was being replaced")
	case <-time.After(200 * time.Millisecond):
	}
	replacement := strings.Repeat("b", 64)
	if err = writeToken(c.Dir, replacement); err != nil {
		t.Fatal(err)
	}
	unlock()
	running := <-started
	if running == nil {
		t.FailNow()
	}
	defer running.Close()
	if running.Server.Token() != replacement {
		t.Fatal("service started with the replaced token")
	}
	// While a service holds the database, the file is never replaced alone.
	if stopped, err := rotateOffline(c); stopped || err != nil {
		t.Fatalf("offline rotation beside a running service: %t %v", stopped, err)
	}
	raw, _ := os.ReadFile(filepath.Join(c.Dir, "token"))
	if string(raw) != replacement {
		t.Fatal("token file replaced while the service ran")
	}
}
