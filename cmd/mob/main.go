package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/provider"
	"github.com/fdkevin0/mob/internal/version"
	"github.com/fdkevin0/mob/webapp"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := newRootCommand().ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func newRootCommand() *cobra.Command {
	var config local.Config
	var background bool

	root := &cobra.Command{Use: "mob", Short: "Local assistant with desktop, terminal and background service", Version: version.Current, Args: cobra.NoArgs, SilenceUsage: true, SilenceErrors: true}
	configuration.AddFlags(root.PersistentFlags())
	root.PersistentPreRunE = func(cmd *cobra.Command, args []string) error {
		loader, err := configuration.NewLoader(root.PersistentFlags())
		if err != nil {
			return err
		}
		config, err = loader.Read()
		return err
	}
	serve := func(cmd *cobra.Command, args []string) error {
		start := local.Start
		if background {
			start = local.StartDaemon
		}
		app, err := start(config, webapp.Assets())
		if err != nil {
			return err
		}
		defer app.Close()
		fmt.Fprintf(cmd.OutOrStdout(), "Mob: %s\nDemo mode: %t\nConfiguration: %s\n", app.Connection.URL, config.Demo, config.Loader.Path())
		if config.Token == "" {
			fmt.Fprintf(cmd.OutOrStdout(), "Token file: %s\n", filepath.Join(config.Dir, "token"))
		} else {
			fmt.Fprintln(cmd.OutOrStdout(), "Access token: supplied through configuration")
		}

		select {
		case <-cmd.Context().Done():
		case <-app.Done:
		}
		return nil
	}
	root.RunE = serve
	serveCommand := &cobra.Command{Use: "serve", Short: "Run the service until interrupted", Args: cobra.NoArgs, RunE: serve}
	serveCommand.Flags().BoolVar(&background, "background", false, "Mark this process as managed by mob start/stop")

	root.AddCommand(serveCommand,
		runnerCommand(&config),
		&cobra.Command{Use: "start", Short: "Start an independent background service", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
			if err := local.StartBackground(config); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Mob is running in the background. GUI and TUI can close without stopping plugins.")
			return nil
		}},
		&cobra.Command{Use: "status", Short: "Show service and configuration reload status", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
			status, err := local.Status(config)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Mob running · background: %t\n", status.Background)
			if status.ConfigError != "" {
				fmt.Fprintln(cmd.OutOrStdout(), "Configuration reload: "+status.ConfigError)
			}
			return nil
		}},
		&cobra.Command{Use: "stop", Short: "Stop the background service", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
			if err := local.StopBackground(config); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Mob stopped.")
			return nil
		}},
		&cobra.Command{Use: "connection", Short: "Start the background service if needed and print its URL and token as JSON", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
			// The desktop app reads this; it never parses Mob's files itself.
			connection, err := local.Credentials(config)
			if err != nil || !local.Reachable(connection) {
				if err := local.StartBackground(config); err != nil {
					return err
				}
				if connection, err = local.Credentials(config); err != nil {
					return err
				}
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(connection)
		}},
		&cobra.Command{Use: "tui", Short: "Open the terminal UI", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
			return runTUI(cmd, config)
		}},
	)
	token := &cobra.Command{Use: "token", Short: "Manage the local access token"}
	token.AddCommand(&cobra.Command{Use: "rotate", Short: "Replace the local access token and sign out every client", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		if err := local.RotateToken(config); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Access token replaced: %s\nSigned-in browsers, terminals and desktop windows must sign in again; run mob open for a browser.\n", filepath.Join(config.Dir, "token"))
		return nil
	}})
	var printOnly, web bool
	open := &cobra.Command{Use: "open", Short: "Sign a browser in to the running service with a one-time link", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		pairing := local.PairingURL
		if web {
			pairing = local.WebURL
		}
		link, err := pairing(config)
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Open this link within 5 minutes; it works once:\n%s\n", link)
		if !printOnly {
			browser.Stdout, browser.Stderr = io.Discard, io.Discard
			_ = browser.OpenURL(link)
		}
		return nil
	}}
	open.Flags().BoolVar(&printOnly, "print", false, "Print the link without opening a browser")
	open.Flags().BoolVar(&web, "web", false, "Open the public web UI (web_url) instead of the page this service serves")
	root.AddCommand(token, open)
	check := &cobra.Command{Use: "config", Short: "Inspect configuration without exposing secrets"}
	check.AddCommand(&cobra.Command{Use: "check", Short: "Validate configuration and show its location", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		if _, err := provider.Load(config.Loader.ProvidersPath()); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Configuration valid: %s\nProviders: %s\nData directory: %s\nState directory: %s\n", config.Loader.Path(), config.Loader.ProvidersPath(), config.Dir, config.StateDir)
		return nil
	}})
	root.AddCommand(check, providerCommand(func() string { return config.Loader.ProvidersPath() }), containerCommand(func() string { return config.Sandbox.Runtime }))
	return root
}
