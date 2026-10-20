package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/runner"
	"github.com/fdkevin0/mob/webapp"
	"github.com/spf13/cobra"
)

func runnerCommand(config *local.Config) *cobra.Command {
	var serve bool
	var healthAddr, keepAwake string
	command := &cobra.Command{Use: "runner", Short: "Connect this Mob to the web with end-to-end encryption", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		var credentials runner.Credentials
		if env := os.Getenv("MOB_RUNNER_PAIRING"); env != "" {
			var err error
			if credentials, err = deployed(env); err != nil {
				return fmt.Errorf("MOB_RUNNER_PAIRING: %w", err)
			}
		} else {
			raw, err := os.ReadFile(filepath.Join(config.Dir, "runner.json"))
			if err != nil {
				return fmt.Errorf("pair this browser first with mob runner pair: %w", err)
			}
			if err := json.Unmarshal(raw, &credentials); err != nil {
				return err
			}
		}
		ctx := cmd.Context()
		if healthAddr != "" {
			// Hosts such as Render want a web service to answer on a port. It says only that the process runs;
			// Mob itself stays on loopback.
			listener, err := net.Listen("tcp", healthAddr)
			if err != nil {
				return err
			}
			health := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })}
			go health.Serve(listener)
			defer health.Close()
		}
		if keepAwake != "" {
			go stayAwake(ctx, keepAwake)
		}
		// done closes when the Mob this process serves stops; it stays nil otherwise.
		var done <-chan struct{}
		var connection local.Connection
		if !serve {
			var err error
			if connection, err = local.Credentials(*config); err != nil {
				return err
			}
			if !local.Reachable(connection) {
				return errors.New("Mob is not running; start it with mob start, or run mob runner --serve")
			}
		} else {
			app, err := local.Start(*config, webapp.Assets())
			if err != nil {
				return err
			}
			defer app.Close()
			connection = app.Connection
			fmt.Fprintf(cmd.OutOrStdout(), "Mob: %s\n", app.Connection.URL)
			var cancel context.CancelFunc
			ctx, cancel = context.WithCancel(ctx)
			defer cancel()
			done = app.Done
			go func() {
				select {
				case <-done:
					cancel()
				case <-ctx.Done():
				}
			}()
		}
		err := runner.Run(ctx, credentials, runner.LocalHandler(connection.URL, connection.Token), func(message string) { fmt.Fprintln(cmd.OutOrStdout(), message) })
		select {
		case <-done:
			return errors.New("Mob stopped")
		default:
			return err
		}
	}}
	command.Flags().BoolVar(&serve, "serve", false, "Run Mob in this process too, for a machine that only runs the runner")
	command.Flags().StringVar(&healthAddr, "health-addr", "", "Answer health checks on this address, such as :10000; it serves nothing else")
	command.Flags().StringVar(&keepAwake, "keep-awake", "", "Request this URL every 10 minutes, so a host that sleeps without inbound requests keeps the runner on")
	command.AddCommand(&cobra.Command{Use: "pair", Short: "Read the web pairing JSON from stdin and save this runner's credentials", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		fmt.Fprintln(cmd.ErrOrStderr(), "Paste the pairing JSON from your signed-in web browser, then press Enter:")
		if err := pair(cmd.Context(), config.Dir, cmd.InOrStdin()); err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Paired. Run mob start, then mob runner. Keep mob runner running for remote access.")
		return nil
	}})
	return command
}

type pairing struct {
	URL  string `json:"url"`
	ID   string `json:"id"`
	Code string `json:"code"`
	Key  string `json:"key"`
}

// deployed reads the credentials of a runner deployed without a terminal, such as on Render.
// Its disk may not survive a restart, so the variable holds the credential itself, not a one-time code.
func deployed(raw string) (runner.Credentials, error) {
	var credentials runner.Credentials
	if err := json.Unmarshal([]byte(raw), &credentials); err != nil {
		return credentials, errors.New("invalid pairing JSON")
	}
	origin, err := runner.Origin(credentials.URL)
	if err != nil {
		return credentials, err
	}
	key, err := base64.StdEncoding.DecodeString(credentials.Key)
	if err != nil || len(key) != 32 || len(credentials.ID) != 36 || len(credentials.Token) != 72 {
		return credentials, errors.New("invalid runner credentials; create a new Render pairing in the browser")
	}
	credentials.URL = origin
	return credentials, nil
}

// stayAwake requests url until ctx ends. The request reaches the host from outside, which the
// runner's own outbound relay connection does not.
func stayAwake(ctx context.Context, url string) {
	client := &http.Client{Timeout: 30 * time.Second}
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil); err == nil {
				if resp, err := client.Do(req); err == nil {
					resp.Body.Close()
				}
			}
		}
	}
}

// pair claims the pairing JSON's one-time code and saves the runner's credentials in dir.
func pair(ctx context.Context, dir string, input io.Reader) error {
	var pair pairing
	if err := json.NewDecoder(io.LimitReader(input, 4096)).Decode(&pair); err != nil {
		return errors.New("invalid pairing JSON")
	}
	origin, err := runner.Origin(pair.URL)
	if err != nil {
		return err
	}
	key, err := base64.StdEncoding.DecodeString(pair.Key)
	if err != nil || len(key) != 32 || len(pair.ID) != 36 || len(pair.Code) != 72 {
		return errors.New("invalid pairing data")
	}
	// Only the one-time code is sent to the server. The encryption key stays on this machine.
	body, _ := json.Marshal(map[string]string{"code": pair.Code})
	req, err := http.NewRequestWithContext(ctx, "POST", origin+"/api/runners/claim", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("could not reach pairing service")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pairing failed (HTTP %d); create a new code in the browser", resp.StatusCode)
	}
	credentials := runner.Credentials{URL: origin, Key: pair.Key}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&credentials); err != nil {
		return err
	}
	// The cloud cannot replace the locally supplied key or origin in its response.
	credentials.URL, credentials.Key = origin, pair.Key
	if credentials.ID != pair.ID || len(credentials.Token) != 72 {
		return errors.New("pairing response does not match this runner")
	}
	raw, _ := json.Marshal(credentials)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".runner-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(dir, "runner.json"))
}
