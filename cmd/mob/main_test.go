package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	if err := os.WriteFile(path, []byte("model: test\napi_key: private-test-secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command = newRootCommand()
	command.SetArgs([]string{"config", "check", "--config", path})
	output.Reset()
	command.SetOut(&output)
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Configuration valid") || strings.Contains(output.String(), "private-test-secret") {
		t.Fatal("config check leaked credentials")
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
	if !strings.Contains(output.String(), "Run the Cloud Gateway relay and signaling hub") || !strings.Contains(output.String(), "--addr") {
		t.Fatalf("gateway command help missing flags: %s", output.String())
	}
}

func TestInheritedFlagsSurviveBackgroundLaunch(t *testing.T) {
	command := newRootCommand()
	command.SetArgs([]string{"config", "check", "--config", "/tmp/mob-test.yaml", "--model", "pinned"})
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
		if got := strings.Join(loader.Arguments(), " "); got != "--config=/tmp/mob-test.yaml --model=pinned" {
			t.Fatalf("background arguments lost inherited flags: %q", got)
		}
	}
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
}
