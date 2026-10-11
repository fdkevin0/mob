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
	"strings"
	"syscall"
	"time"

	"github.com/fdkevin0/mob/internal/app"
	"github.com/fdkevin0/mob/internal/chat"
)

// RotateToken replaces the local access token. A running service switches to
// the new token at once, so every signed-in browser, TUI and desktop window
// must sign in again. Only when nothing listens on the service address does it
// rewrite the token file alone.
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
		case refused(err):
			return rotateOffline(c, connection)
		case err != nil:
			return fmt.Errorf("cannot reach Mob at %s to rotate its token: %w", connection.URL, err)
		case status == http.StatusOK:
			_, err = call(connection, "/api/token/rotate", http.StatusNoContent)
			return err
		case status != http.StatusUnauthorized:
			return fmt.Errorf("Mob at %s answered HTTP %d", connection.URL, status)
		}
	}
	return errors.New("the token file does not match the running Mob; restart Mob, then run mob token rotate again")
}

// rotateOffline rewrites the token file, then checks that no service started
// meanwhile with the token it replaced.
func rotateOffline(c Config, previous Connection) error {
	next := Connection{URL: previous.URL, Token: chat.NewID() + chat.NewID()}
	if err := writeToken(c.Dir, next.Token); err != nil {
		return err
	}
	status, err := probe(next)
	if refused(err) || (err == nil && status == http.StatusOK) {
		return nil
	}
	return errors.New("Mob started while its token was being replaced; run mob token rotate again")
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

// refused reports a connection refused because nothing listens on the address.
func refused(err error) bool {
	var errno syscall.Errno
	// 10061 is WSAECONNREFUSED, which Windows reports instead of ECONNREFUSED.
	return errors.As(err, &errno) && (errno == syscall.ECONNREFUSED || errno == 10061)
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
