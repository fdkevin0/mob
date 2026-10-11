package local

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
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
	connection, err := Credentials(c)
	if err != nil {
		return "", err
	}
	if !Reachable(connection) {
		return "", errors.New("Mob is not running; start it with mob start")
	}
	body, err := call(connection, "/api/pairing", http.StatusOK)
	if err != nil {
		return "", err
	}
	var pairing struct {
		Code string `json:"code"`
	}
	if err = json.Unmarshal(body, &pairing); err != nil || pairing.Code == "" {
		return "", errors.New("Mob returned an invalid pairing code")
	}
	// The fragment never reaches the server, its logs or a Referer header.
	return connection.URL + "/#pair=" + pairing.Code, nil
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
