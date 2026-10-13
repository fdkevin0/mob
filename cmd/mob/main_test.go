package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/spf13/cobra"
)

func TestCobraHelpAndConfigValidation(t *testing.T) {
	t.Setenv("MOB_CONFIG", filepath.Join(t.TempDir(), "absent.yaml"))
	command := newRootCommand()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&output)
	command.SetArgs([]string{"--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "--config") || !strings.Contains(output.String(), "completion") {
		t.Fatal("standard Cobra help missing")
	}
	command = newRootCommand()
	command.SetArgs([]string{"config", "check"})
	command.SetOut(&output)
	if err := command.Execute(); err == nil {
		t.Fatal("explicit missing config accepted")
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("demo: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command = newRootCommand()
	command.SetArgs([]string{"config", "check", "--config", path})
	output.Reset()
	command.SetOut(&output)
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Configuration valid") || !strings.Contains(output.String(), "providers.json") {
		t.Fatal("config check incomplete")
	}
	command = newRootCommand()
	command.SetArgs([]string{"status", "unexpected"})
	if err := command.Execute(); err == nil {
		t.Fatal("extra positional argument accepted")
	}
}

func TestGatewayCommandHelp(t *testing.T) {
	command := newRootCommand()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&output)
	command.SetArgs([]string{"gateway", "--help"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Run the Cloud Gateway relay and signaling hub") || !strings.Contains(output.String(), "--gateway-addr") {
		t.Fatalf("gateway command help missing flags: %s", output.String())
	}
}

func TestInheritedFlagsSurviveBackgroundLaunch(t *testing.T) {
	command := newRootCommand()
	command.SetArgs([]string{"config", "check", "--config", "/tmp/mob-test.yaml", "--demo"})
	command.PersistentPreRunE = nil
	check, _, err := command.Find([]string{"config", "check"})
	if err != nil {
		t.Fatal(err)
	}
	check.RunE = nil
	check.Run = func(_ *cobra.Command, _ []string) {
		loader, err := configuration.NewLoader(command.PersistentFlags())
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.Join(loader.Arguments(), " "); got != "--config=/tmp/mob-test.yaml --demo=true" {
			t.Fatalf("background arguments lost inherited flags: %q", got)
		}
	}
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
}

func TestConfigurationFlagsThroughCobra(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("demo: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_CONFIG", path)
	t.Setenv("MOB_MAX_TOOL_STEPS", "invalid-env")
	command := newRootCommand()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetArgs([]string{"config", "check", "--max-tool-steps=10", "--gateway-node-id=node", "--sandbox-image=alpine:3.20", "--web-url="})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Configuration valid") {
		t.Fatal("flags were not loaded")
	}
}

func TestGatewayRejectsLocalFlagsBeforeStarting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("gateway:\n  addr: 127.0.0.1:0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MOB_CONFIG", path)
	for _, args := range [][]string{
		{"gateway", "--token=" + strings.Repeat("x", 40)},
		{"gateway", "--token=short"},
		{"gateway", "--addr=127.0.0.1:0"},
		{"--token=" + strings.Repeat("x", 40), "gateway"},
	} {
		command := newRootCommand()
		var output bytes.Buffer
		command.SetOut(&output)
		command.SetErr(&output)
		command.SetArgs(args)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		err := command.ExecuteContext(ctx)
		cancel()
		if err == nil || !strings.Contains(err.Error(), "mob gateway uses --gateway-token and --gateway-addr") {
			t.Fatalf("legacy gateway flags did not fail with migration guidance: %v", err)
		}
		if strings.Contains(output.String(), "listening") {
			t.Fatal("gateway started before rejecting local flags")
		}
	}
}

func TestTUISelectorPreflight(t *testing.T) {
	entry := filepath.Join(t.TempDir(), "main.tsx")
	if err := os.WriteFile(entry, nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ name, mode, entry, want string }{
		{"invalid", "other", "", "MOB_TUI must be go or ts"},
		{"relative entry", "ts", "apps/tui/src/main.tsx", "absolute path"},
		{"missing entry", "ts", entry + ".missing", "source unavailable"},
		{"directory entry", "ts", filepath.Dir(entry), "source unavailable"},
		{"missing bun", "ts", entry, "requires Bun"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("MOB_CONFIG", filepath.Join(t.TempDir(), "absent.yaml"))
			t.Setenv("MOB_TUI", test.mode)
			t.Setenv("MOB_TUI_ENTRY", test.entry)
			t.Setenv("PATH", t.TempDir())
			command := newRootCommand()
			command.SetArgs([]string{"tui"})
			// Bypass unrelated config loading: none of these should reach service startup.
			command.PersistentPreRunE = nil
			if err := command.Execute(); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("got %v, want %s", err, test.want)
			}
		})
	}
}

func TestTypeScriptTUILaunch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix subprocess fixture")
	}
	const token = "test-token-not-a-secret-0123456789abcdef"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/config" || r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()
	dir := t.TempDir()
	entry := filepath.Join(dir, "apps", "tui", "src", "main.tsx")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, nil, 0600); err != nil {
		t.Fatal(err)
	}
	// A real child process records its launch contract, forwards all streams, and exits.
	script := `#!/bin/sh
trap 'echo cleaned > "$MOB_TEST_CLEANUP"; exit 0' INT TERM
read -r line
printf 'stdout:%s\n' "$line"
printf 'stderr\n' >&2
printf '%s\n' "$MOB_URL" "$MOB_TOKEN" "$PWD" "$@" > "$MOB_TEST_LAUNCH"
if [ "$MOB_TEST_EXIT" = cancel ]; then
  while :; do :; done
fi
exit "$MOB_TEST_EXIT"
`
	if err := os.WriteFile(filepath.Join(dir, "bun"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("MOB_TUI", "ts")
	t.Setenv("MOB_TUI_ENTRY", entry)
	t.Setenv("MOB_TOKEN", token)
	t.Setenv("MOB_URL", "http://127.0.0.1:1") // Must be replaced with the actual connection.
	for _, exit := range []string{"0", "7", "cancel"} {
		t.Run("exit "+exit, func(t *testing.T) {
			t.Setenv("MOB_TEST_EXIT", exit)
			record := filepath.Join(t.TempDir(), "launch.txt")
			t.Setenv("MOB_TEST_LAUNCH", record)
			cleanup := record + ".cleaned"
			t.Setenv("MOB_TEST_CLEANUP", cleanup)
			config := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(config, []byte("demo: true\n"), 0600); err != nil {
				t.Fatal(err)
			}
			command := newRootCommand()
			command.SetArgs([]string{"tui", "--config", config, "--addr", strings.TrimPrefix(server.URL, "http://"), "--data-dir", t.TempDir(), "--state-dir", t.TempDir()})
			var stdout, stderr bytes.Buffer
			command.SetIn(strings.NewReader("terminal input\n"))
			command.SetOut(&stdout)
			command.SetErr(&stderr)
			var err error
			if exit == "cancel" {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan error, 1)
				go func() { done <- command.ExecuteContext(ctx) }()
				deadline := time.Now().Add(5 * time.Second)
				for {
					if _, ready := os.Stat(record); ready == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("child did not become ready")
					}
					time.Sleep(10 * time.Millisecond)
				}
				cancel()
				err = <-done
				if raw, readErr := os.ReadFile(cleanup); readErr != nil || string(raw) != "cleaned\n" || !errors.Is(err, context.Canceled) {
					t.Fatalf("child cleanup not allowed on cancellation: %v / %v", err, readErr)
				}
			} else {
				err = command.Execute()
			}
			if exit == "0" && err != nil || exit == "7" && (err == nil || !strings.Contains(err.Error(), "exit status 7")) {
				t.Fatalf("exit %s: %v", exit, err)
			}
			if stdout.String() != "stdout:terminal input\n" || stderr.String() != "stderr\n" {
				t.Fatalf("streams not inherited: %q / %q", stdout.String(), stderr.String())
			}
			raw, err := os.ReadFile(record)
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
			if len(lines) < 4 || lines[0] != server.URL || lines[1] != token || lines[2] != filepath.Dir(filepath.Dir(entry)) {
				t.Fatalf("incorrect connection or working directory: %q", lines)
			}
			args := strings.Join(lines[3:], " ")
			if !strings.Contains(args, entry) || strings.Contains(args, token) {
				t.Fatal("source entry missing or token exposed in arguments")
			}
			response, err := http.Get(server.URL)
			if err != nil {
				t.Fatalf("reused service was stopped: %v", err)
			}
			response.Body.Close()
		})
	}
}
