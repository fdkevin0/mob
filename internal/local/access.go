package local

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/app"
	"github.com/fdkevin0/mob/internal/chat"
)

// RotateToken replaces the local access token. A running service switches to
// the new token at once, so every signed-in browser, TUI and desktop window
// must sign in again; otherwise only the token file changes.
func RotateToken(c Config) error {
	if os.Getenv("MOB_TOKEN") != "" {
		return app.ErrTokenFromEnvironment
	}
	connection, err := Credentials(c)
	if err != nil || !Reachable(connection) {
		return writeToken(c.Dir, chat.NewID()+chat.NewID())
	}
	_, err = call(connection, "/api/token/rotate", http.StatusNoContent)
	return err
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
