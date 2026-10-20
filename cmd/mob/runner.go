package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/runner"
	"github.com/spf13/cobra"
)

func runnerCommand(config *local.Config) *cobra.Command {
	command := &cobra.Command{Use: "runner", Short: "Connect this Mob to the web with end-to-end encryption", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		raw, err := os.ReadFile(filepath.Join(config.Dir, "runner.json"))
		if err != nil {
			return fmt.Errorf("pair this browser first with mob runner pair: %w", err)
		}
		var credentials runner.Credentials
		if err := json.Unmarshal(raw, &credentials); err != nil {
			return err
		}
		connection, err := local.Credentials(*config)
		if err != nil {
			return err
		}
		if !local.Reachable(connection) {
			return errors.New("Mob is not running; start it with mob start")
		}
		return runner.Run(cmd.Context(), credentials, runner.LocalHandler(connection.URL, connection.Token), func(message string) { fmt.Fprintln(cmd.OutOrStdout(), message) })
	}}
	command.AddCommand(&cobra.Command{Use: "pair", Short: "Read the web pairing JSON from stdin and save this runner's credentials", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		fmt.Fprintln(cmd.ErrOrStderr(), "Paste the pairing JSON from your signed-in web browser, then press Enter:")
		var pair struct {
			URL  string `json:"url"`
			ID   string `json:"id"`
			Code string `json:"code"`
			Key  string `json:"key"`
		}
		if err := json.NewDecoder(io.LimitReader(cmd.InOrStdin(), 4096)).Decode(&pair); err != nil {
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
		req, err := http.NewRequestWithContext(cmd.Context(), "POST", origin+"/api/runners/claim", bytes.NewReader(body))
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
		if err := os.MkdirAll(config.Dir, 0700); err != nil {
			return err
		}
		file, err := os.CreateTemp(config.Dir, ".runner-*")
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
		if err := os.Rename(file.Name(), filepath.Join(config.Dir, "runner.json")); err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Paired. Run mob start, then mob runner. Keep mob runner running for remote access.")
		return nil
	}})
	return command
}
