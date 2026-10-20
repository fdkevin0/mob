package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/runner"
	"github.com/fdkevin0/mob/webapp"
	"github.com/spf13/cobra"
)

func runnerCommand(config *local.Config) *cobra.Command {
	var serve bool
	command := &cobra.Command{Use: "runner", Short: "Connect this Mob to the web with end-to-end encryption", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		path := filepath.Join(config.Dir, "runner.json")
		// A runner deployed without a terminal, such as on Render, is paired from the environment.
		// The code works once, so a saved pairing is reused until the variable names another runner.
		if env := os.Getenv("MOB_RUNNER_PAIRING"); env != "" && !pairedAs(path, env) {
			if err := pair(cmd.Context(), config.Dir, strings.NewReader(env)); err != nil {
				return fmt.Errorf("MOB_RUNNER_PAIRING: %w", err)
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Paired from MOB_RUNNER_PAIRING")
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("pair this browser first with mob runner pair: %w", err)
		}
		var credentials runner.Credentials
		if err := json.Unmarshal(raw, &credentials); err != nil {
			return err
		}
		ctx := cmd.Context()
		// done closes when the Mob this process serves stops; it stays nil otherwise.
		var done <-chan struct{}
		var connection local.Connection
		if !serve {
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
		err = runner.Run(ctx, credentials, runner.LocalHandler(connection.URL, connection.Token), func(message string) { fmt.Fprintln(cmd.OutOrStdout(), message) })
		select {
		case <-done:
			return errors.New("Mob stopped")
		default:
			return err
		}
	}}
	command.Flags().BoolVar(&serve, "serve", false, "Run Mob in this process too, for a machine that only runs the runner")
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

// pairedAs reports whether the saved credentials belong to the runner the pairing JSON names.
func pairedAs(path, raw string) bool {
	var want pairing
	var have runner.Credentials
	saved, err := os.ReadFile(path)
	return err == nil && json.Unmarshal([]byte(raw), &want) == nil && json.Unmarshal(saved, &have) == nil && want.ID != "" && want.ID == have.ID
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
