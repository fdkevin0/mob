package local

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/app"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/gofrs/flock"
)

// RotateToken replaces the local access token. A running service switches to
// the new token at once, so every signed-in browser, TUI and desktop window
// must sign in again. Only when no service holds the database does it rewrite
// the token file alone.
func RotateToken(c Config) error {
	if os.Getenv("MOB_TOKEN") != "" {
		return app.ErrTokenFromEnvironment
	}
	// A second attempt reads the file again in case another rotation just replaced it.
	for attempt := 0; attempt < 2; attempt++ {
		connection, err := Credentials(c)
		if errors.Is(err, fs.ErrNotExist) {
			connection, err = Connection{URL: "http://" + c.Addr}, nil
		}
		if err != nil {
			return err
		}
		status, err := probe(connection)
		switch {
		case err == nil && status == http.StatusOK:
			_, err = call(connection, "/api/token/rotate", http.StatusNoContent)
			return err
		case err == nil && status == http.StatusUnauthorized:
			continue
		case err == nil:
			return fmt.Errorf("Mob at %s answered HTTP %d", connection.URL, status)
		}
		stopped, offline := rotateOffline(c)
		if offline != nil || stopped {
			return offline
		}
		return fmt.Errorf("Mob is starting or not responding at %s; run mob token rotate again: %w", connection.URL, err)
	}
	return errors.New("the token file does not match the running Mob; restart Mob, then run mob token rotate again")
}

// rotateOffline rewrites the token file when no service holds the database.
// It holds the token lock that service startup takes around opening the
// database and reading the token, so a starting service reads either the old
// file before this runs or the new one after.
func rotateOffline(c Config) (stopped bool, err error) {
	unlock, err := lockToken(c.Dir)
	if err != nil {
		return false, err
	}
	defer unlock()
	database := flock.New(storePath(c) + ".lock")
	held, err := database.TryLock()
	if err != nil || !held {
		return false, err
	}
	defer database.Unlock()
	return true, writeToken(c.Dir, chat.NewID()+chat.NewID())
}

// lockToken serializes token file replacement with service startup across processes.
func lockToken(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(dir, "token.lock"))
	if err := lock.Lock(); err != nil {
		return nil, err
	}
	return func() { _ = lock.Unlock() }, nil
}

func probe(connection Connection) (int, error) {
	req, err := http.NewRequest("GET", connection.URL+"/api/config", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+connection.Token)
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// PairingURL returns a link that signs a browser in to the running service once.
func PairingURL(c Config) (string, error) {
	connection, code, err := pairingCode(c)
	if err != nil {
		return "", err
	}
	// The fragment never reaches the server, its logs or a Referer header.
	return connection.URL + "/#pair=" + code, nil
}

// Offer is what a mob open --web link gives the public web UI: where this Mob
// listens and a one-time code to exchange there for the access token.
type Offer struct {
	Version int    `json:"v"`
	URL     string `json:"url"`
	Code    string `json:"code"`
}

// WebURL returns a link that signs the public web UI in to the running service
// once. The offer travels base64url-encoded in the fragment, so the site
// serving the page never receives it.
func WebURL(c Config) (string, error) {
	if c.WebURL == "" {
		return "", errors.New("web_url is empty in the configuration; set it to use the public web UI")
	}
	connection, code, err := pairingCode(c)
	if err != nil {
		return "", err
	}
	// The page's content security policy lets it reach only these hosts.
	if u, err := url.Parse(connection.URL); err != nil || u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" {
		return "", fmt.Errorf("the public web UI reaches Mob only at 127.0.0.1 or localhost, not %s", connection.URL)
	}
	offer, err := json.Marshal(Offer{Version: 1, URL: connection.URL, Code: code})
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(c.WebURL, "/") + "/#offer=" + base64.RawURLEncoding.EncodeToString(offer), nil
}

func pairingCode(c Config) (Connection, string, error) {
	connection, err := Credentials(c)
	if err != nil {
		return Connection{}, "", err
	}
	if !Reachable(connection) {
		return Connection{}, "", errors.New("Mob is not running; start it with mob start")
	}
	body, err := call(connection, "/api/pairing", http.StatusOK)
	if err != nil {
		return Connection{}, "", err
	}
	var pairing struct {
		Code string `json:"code"`
	}
	if err = json.Unmarshal(body, &pairing); err != nil || pairing.Code == "" {
		return Connection{}, "", errors.New("Mob returned an invalid pairing code")
	}
	return connection, pairing.Code, nil
}

func call(connection Connection, path string, want int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", connection.URL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+connection.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != want {
		if message := strings.TrimSpace(string(body)); message != "" {
			return nil, errors.New(message)
		}
		return nil, fmt.Errorf("%s HTTP %d", path, resp.StatusCode)
	}
	return body, nil
}
