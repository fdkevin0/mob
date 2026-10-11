package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/charmbracelet/x/term"
	"github.com/fdkevin0/mob/internal/catalog"
	"github.com/fdkevin0/mob/internal/provider"
	"github.com/spf13/cobra"
)

// providerCommand edits providers.json directly; a running service reloads it.
func providerCommand(path func() string) *cobra.Command {
	root := &cobra.Command{Use: "provider", Aliases: []string{"providers"}, Short: "Manage model providers (providers.json)"}
	open := func() (*provider.Registry, error) { return provider.Open(path(), catalog.Default(), provider.File{}) }

	var presetNames []string
	for _, p := range provider.Presets() {
		presetNames = append(presetNames, p.ID)
	}
	var opts struct {
		preset, key, name, chat, anthropic, modelsURL, defaultModel string
		keyStdin, offline, clearKey, clearHeaders                   bool
		models                                                      []string
	}
	add := &cobra.Command{
		Use:   "add ID",
		Short: "Add a provider, or update one already added",
		Long: "Add a provider, or update one already added.\n\nPresets: " + strings.Join(presetNames, ", ") +
			"\nA preset's ID is enough: mob provider add deepseek --key-stdin\nmagpie finds the magpie gateway on this machine: mob provider add magpie\nAny other ID needs --chat or --anthropic: mob provider add work --chat https://relay.example/v1 --key-stdin\n" +
			"On a terminal the key is asked for when the provider needs one. Prefer --key-stdin to --key, which shell history keeps.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.ToLower(args[0])
			r, err := open()
			if err != nil {
				return err
			}
			existing := r.File().Find(id)
			p := provider.Provider{ID: id}
			if existing != nil {
				p = *existing
			}
			if opts.preset != "" {
				p.Preset = opts.preset
			} else if existing == nil && provider.FindPreset(id) != nil {
				p.Preset = id
			}
			for _, v := range []struct {
				flag string
				dst  *string
				val  string
			}{{"name", &p.Name, opts.name}, {"chat", &p.Chat, opts.chat}, {"anthropic", &p.Anthropic, opts.anthropic}, {"models-url", &p.ModelsURL, opts.modelsURL}} {
				if cmd.Flags().Changed(v.flag) {
					*v.dst = strings.TrimSpace(v.val)
				}
			}
			// magpie's gateway listens on the port in its settings, which is
			// looked up unless a URL was given.
			if p.Preset == "magpie" && !opts.offline && !cmd.Flags().Changed("chat") && !cmd.Flags().Changed("anthropic") {
				chat, anthropic, err := provider.FindMagpie(cmd.Context(), nil)
				if err != nil {
					return fmt.Errorf("%w (or save it as is with --offline)", err)
				}
				p.Chat, p.Anthropic = "", ""
				if chat != p.Endpoint(provider.Chat) {
					p.Chat, p.Anthropic = chat, anthropic
				}
			}
			if p.Preset == "" && p.Chat == "" && p.Anthropic == "" {
				return fmt.Errorf("%q is not a preset (%s); give its base URL with --chat or --anthropic", id, strings.Join(presetNames, ", "))
			}
			// Credentials saved for one destination never follow the provider
			// to another: the next request, a model list fetch, would send them.
			if opts.clearKey {
				p.Key = ""
			}
			if opts.clearHeaders {
				p.Headers = nil
			}
			if existing != nil && existing.Destination() != p.Destination() {
				if p.Key != "" && !opts.keyStdin && !cmd.Flags().Changed("key") {
					return fmt.Errorf("%s now points elsewhere; give its key again with --key-stdin, or drop it with --clear-key", id)
				}
				if len(p.Headers) > 0 {
					return fmt.Errorf("%s now points elsewhere and has saved headers; drop them with --clear-headers", id)
				}
			}
			switch {
			case opts.keyStdin:
				line, err := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
				if err != nil && !errors.Is(err, io.EOF) {
					return err
				}
				p.Key = strings.TrimSpace(line)
			case cmd.Flags().Changed("key"):
				p.Key = strings.TrimSpace(opts.key)
			case p.Key == "" && needsKey(p) && term.IsTerminal(os.Stdin.Fd()):
				pr := provider.FindPreset(p.Preset)
				if pr != nil && pr.KeysURL != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "Create a key at %s\n", pr.KeysURL)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "API key for %s (hidden): ", id)
				raw, err := term.ReadPassword(os.Stdin.Fd())
				fmt.Fprintln(cmd.OutOrStdout())
				if err != nil {
					return err
				}
				p.Key = strings.TrimSpace(string(raw))
			}
			if p.Key == "" && needsKey(p) {
				return fmt.Errorf("%s needs an API key: mob provider add %s --key-stdin", id, id)
			}
			if err := p.Validate(); err != nil {
				return err
			}
			var listed []string
			if !opts.offline {
				ctx, cancel := context.WithTimeout(cmd.Context(), 20*time.Second)
				listed, err = r.Fetch(ctx, p)
				cancel()
				if err != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "Warning: %s. Saved anyway; check the key and URL.\n", err)
				}
			}
			if cmd.Flags().Changed("models") {
				p.Models = slices.DeleteFunc(opts.models, func(s string) bool { return strings.TrimSpace(s) == "" })
				p.PickedFrom = listed
			}
			err = r.Update(func(f *provider.File) error {
				if q := f.Find(id); q != nil {
					*q = p
				} else {
					f.Providers = append(f.Providers, p)
				}
				if opts.defaultModel != "" {
					f.Default = id + "/" + strings.TrimPrefix(opts.defaultModel, id+"/")
				}
				return nil
			})
			if err != nil {
				return err
			}
			verb := "Added"
			if existing != nil {
				verb = "Updated"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s %s (%s) in %s\n", verb, id, p.DisplayName(), r.Path)
			if len(listed) > 0 {
				fmt.Fprintf(cmd.OutOrStdout(), "It lists %d models, e.g. %s\n", len(listed), strings.Join(listed[:min(len(listed), 5)], ", "))
			}
			fmt.Fprintf(cmd.OutOrStdout(), "In a conversation: /models %s, then /model %s/MODEL\n", id, id)
			return nil
		},
	}
	add.Flags().StringVar(&opts.preset, "preset", "", "Preset to start from (default: the ID, when it is one)")
	add.Flags().BoolVar(&opts.keyStdin, "key-stdin", false, "Read the API key from standard input")
	add.Flags().StringVar(&opts.key, "key", "", "API key (kept by shell history; prefer --key-stdin)")
	add.Flags().BoolVar(&opts.clearKey, "clear-key", false, "Remove the saved key (needed when changing a URL without a new key)")
	add.Flags().BoolVar(&opts.clearHeaders, "clear-headers", false, "Remove saved headers (needed when changing a URL that has them)")
	add.Flags().StringVar(&opts.name, "name", "", "Display name")
	add.Flags().StringVar(&opts.chat, "chat", "", "OpenAI Chat Completions base URL, e.g. https://host/v1")
	add.Flags().StringVar(&opts.anthropic, "anthropic", "", "Anthropic Messages base URL (without /v1)")
	add.Flags().StringVar(&opts.modelsURL, "models-url", "", "Model list URL, when not BASE/models")
	add.Flags().StringSliceVar(&opts.models, "models", nil, "Models to offer (default: every model it lists)")
	add.Flags().StringVar(&opts.defaultModel, "default", "", "Also make this model the default")
	add.Flags().BoolVar(&opts.offline, "offline", false, "Save without asking the provider for its model list")

	ls := &cobra.Command{Use: "ls", Aliases: []string{"list"}, Short: "List providers", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		r, err := open()
		if err != nil {
			return err
		}
		f := r.File()
		fmt.Fprintf(cmd.OutOrStdout(), "%s\nDefault model: %s\n\n", r.Path, cmpOr(f.Default, "(none)"))
		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tNAME\tENDPOINT\tKEY\tMODELS")
		for _, p := range f.Providers {
			endpoint := p.Endpoint(provider.Chat)
			if endpoint == "" {
				endpoint = p.Endpoint(provider.Anthropic) + " (anthropic)"
			}
			models := "all listed"
			if len(p.Models) > 0 {
				models = strings.Join(p.Models, ",")
			}
			if p.Off {
				models += " (off)"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", p.ID, p.DisplayName(), endpoint, cmpOr(p.MaskedKey(), "-"), models)
		}
		return w.Flush()
	}}

	rm := &cobra.Command{Use: "rm ID", Aliases: []string{"remove"}, Short: "Remove a provider and its key", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		r, err := open()
		if err != nil {
			return err
		}
		id := strings.ToLower(args[0])
		cleared := false
		err = r.Update(func(f *provider.File) error {
			n := len(f.Providers)
			f.Providers = slices.DeleteFunc(f.Providers, func(p provider.Provider) bool { return p.ID == id })
			if len(f.Providers) == n {
				return fmt.Errorf("no provider %q", id)
			}
			if strings.HasPrefix(f.Default, id+"/") {
				f.Default, cleared = "", true
			}
			return nil
		})
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Removed %s. The previous file is kept as %s.bak\n", id, r.Path)
		if cleared {
			fmt.Fprintln(cmd.OutOrStdout(), "It held the default model; pick another with /model default NAME.")
		}
		return nil
	}}
	root.AddCommand(add, ls, rm)
	return root
}

// needsKey reports whether requests need a key: presets for local servers
// and OpenCode's free tier don't; a custom endpoint may not.
func needsKey(p provider.Provider) bool {
	pr := provider.FindPreset(p.Preset)
	return pr != nil && !pr.NoKey && pr.PublicKey == ""
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
