package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
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
