package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/tui"
	"github.com/fdkevin0/mob/webapp"
	"github.com/spf13/cobra"
)

func runTUI(cmd *cobra.Command, config local.Config) error {
	var pilot *exec.Cmd
	switch os.Getenv("MOB_TUI") {
	case "", "go":
	case "ts":
		entry := os.Getenv("MOB_TUI_ENTRY")
		if entry == "" {
			executable, err := os.Executable()
			if err != nil {
				return err
			}
			executable, err = filepath.EvalSymlinks(executable)
			if err != nil {
				return err
			}
			// Source builds put mob in <checkout>/build; never discover code from cwd.
			entry = filepath.Join(filepath.Dir(executable), "..", "apps", "tui", "src", "main.tsx")
		}
		if !filepath.IsAbs(entry) {
			return fmt.Errorf("MOB_TUI_ENTRY must be an absolute path to apps/tui/src/main.tsx")
		}
		info, err := os.Stat(entry)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("TypeScript TUI source unavailable at %s; set MOB_TUI_ENTRY to the absolute path to apps/tui/src/main.tsx in a source checkout", entry)
		}
		bun, err := exec.LookPath("bun")
		if err != nil {
			return fmt.Errorf("MOB_TUI=ts requires Bun >=1.3.14 on PATH: %w", err)
		}
		pilot = exec.CommandContext(cmd.Context(), bun, entry)
		pilot.Dir = filepath.Dir(filepath.Dir(entry))
		pilot.Stdin, pilot.Stdout, pilot.Stderr = cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr()
		// Let the native renderer restore the terminal before escalating to Kill.
		pilot.Cancel = func() error {
			if err := pilot.Process.Signal(os.Interrupt); err != nil {
				return pilot.Process.Kill()
			}
			return nil
		}
		pilot.WaitDelay = 3 * time.Second
	default:
		return fmt.Errorf("MOB_TUI must be go or ts (unset selects go)")
	}

	connection, close, err := local.ConnectOrStart(config, webapp.Assets())
	if err != nil {
		return err
	}
	defer close()
	if pilot == nil {
		return tui.Run(connection)
	}
	// Pass the actual connection, overriding inherited values without exposing tokens in argv.
	pilot.Env = append(pilot.Environ(), "MOB_URL="+connection.URL, "MOB_TOKEN="+connection.Token)
	if err := pilot.Run(); err != nil {
		return fmt.Errorf("TypeScript TUI failed: %w; ensure Bun >=1.3.14 and run bun install --frozen-lockfile in the source checkout", err)
	}
	return nil
}
