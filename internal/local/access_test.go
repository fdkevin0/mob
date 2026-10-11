package local

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
