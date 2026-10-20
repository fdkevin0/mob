package configuration

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/adrg/xdg"
	"github.com/fdkevin0/mob/internal/plugins/mcp"
	"github.com/fdkevin0/mob/internal/sandbox"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
)

type option struct {
	key         string
	value       any
	help        string
	defaultText string
	secret      bool
}

func (o option) flag() string { return strings.NewReplacer(".", "-", "_", "-").Replace(o.key) }
func (o option) env() string  { return "MOB_" + strings.ToUpper(strings.ReplaceAll(o.key, ".", "_")) }

// options owns defaults, CLI flags, environment bindings and reference documentation.
func options() []option {
	return []option{
		{"config", "", "Configuration file path (selector only; not a file field)", "XDG config home/mob/config.yaml", false},
		{"data_dir", defaultDataDir(), "SQLite, token and conversation workspaces; restart required", "XDG data home/mob (existing legacy database reused)", false},
		{"state_dir", filepath.Join(xdg.StateHome, "mob"), "Background logs; restart required", "XDG state home/mob", false},
		{"addr", "127.0.0.1:8787", "Local service loopback IP and port; restart required", "", false},
		{"demo", false, "Use offline model simulation; restart required", "", false},
		{"max_tool_steps", DefaultToolSteps, "Model calls per turn (1-100)", "", false},
		{"web_url", DefaultWebURL, "Public web UI URL; an empty flag or file value disables it", "", false},
		{"token", "", "Local access token (at least 32 bytes); empty uses the managed token file; restart required", "", true},
		{"gateway.url", "", "Gateway URL for this service to register with; restart required", "", false},
		{"gateway.node_id", "", "Gateway node ID; empty uses hostname or node-local; restart required", "", false},
		{"gateway.addr", ":8788", "Gateway server listen address; restart required", "", false},
		{"gateway.token", "", "Gateway authentication token; empty disables gateway authentication; restart required", "", true},
		{"sandbox.enabled", false, "Expose the container sandbox tool", "", false},
		{"sandbox.runtime", "", "Container runtime: containerd, apple or wslc; empty selects by platform", "", false},
		{"sandbox.image", sandbox.DefaultImage, "Container image for commands", "", false},
		{"sandbox.network", "", "Container network; none disables it, empty uses runtime default", "", false},
		{"sandbox.cpus", 0, "Nonnegative CPU limit; zero uses runtime default", "", false},
		{"sandbox.memory", "", "Memory limit with unit, at least 64m; empty uses runtime default", "", false},
		{"sandbox.isolation", "", "gvisor requires containerd; empty uses runtime default", "", false},
		{"mcp_servers", "{}", "MCP server map; JSON object in flags/environment, native map in files", "", true},
		{"mcp_registry.url", mcp.DefaultRegistry, "MCP registry the model searches for remote servers to install", "", false},
		{"mcp_registry.namespaces", "", "Comma-separated registry name globs, such as com.cloudflare.mcp/*, the model may install from; empty offers only Mob's own list", "", false},
	}
}

func AddFlags(flags *pflag.FlagSet) {
	for _, o := range options() {
		help := o.help + " (" + o.env() + ")"
		switch value := o.value.(type) {
		case string:
			flags.String(o.flag(), value, help)
		case bool:
			flags.Bool(o.flag(), value, help)
		case int:
			flags.Int(o.flag(), value, help)
		}
	}
}

func configuredViper(flags *pflag.FlagSet, selector bool) (*viper.Viper, error) {
	v := viper.New()
	v.SetEnvPrefix("MOB")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	for _, o := range options() {
		if (o.key == "config") != selector {
			continue
		}
		v.SetDefault(o.key, o.value)
		if err := v.BindEnv(o.key); err != nil {
			return nil, err
		}
		if err := v.BindPFlag(o.key, flags.Lookup(o.flag())); err != nil {
			return nil, err
		}
	}
	return v, nil
}

// Environ forwards secret flags to the daemon without copying them into its argv.
func (l *Loader) Environ() []string {
	env := os.Environ()
	for _, o := range options() {
		f := l.flags.Lookup(o.flag())
		if !o.secret || !f.Changed {
			continue
		}
		prefix := o.env() + "="
		filtered := env[:0]
		for _, entry := range env {
			if !strings.HasPrefix(entry, prefix) {
				filtered = append(filtered, entry)
			}
		}
		env = append(filtered, prefix+f.Value.String())
	}
	return env
}

// Reference contains static metadata only, never current environment values.
func Reference() string {
	var b strings.Builder
	b.WriteString(`# Environment variables and configuration

Generated from internal/configuration/options.go; run go run ./cmd/configdocs.

Explicit CLI flags > nonempty MOB_ environment variables > configuration file > defaults.
Empty environment values are ignored consistently; use a flag or file value to clear a string.
There is no .env loader. Restart after changing the process environment.

Keys map to flags by replacing dots/underscores with hyphens, and to environment
variables by replacing dots with underscores, uppercasing and prefixing MOB_.
The config selector chooses the file before loading it and cannot appear inside that file.

| File key | CLI flag | Environment | Default | Purpose |
| --- | --- | --- | --- | --- |
`)
	for _, o := range options() {
		value := fmt.Sprint(o.value)
		if value == "" {
			value = `""`
		}
		if o.defaultText != "" {
			value = o.defaultText
		}
		description := o.help
		if o.secret {
			description += "; sensitive: prefer a protected file or environment over argv"
		}
		fmt.Fprintf(&b, "| `%s` | `--%s` | `%s` | `%s` | %s |\n", o.key, o.flag(), o.env(), value, description)
	}
	b.WriteString(`
This reference covers runtime configuration. Provider keys and plugin settings
use their own stores; command actions such as open --print are not settings.
XDG_* directory conventions and CI/build variables belong to their respective tools.

See [Configuration](features/configuration.md) for file safety, reload behavior
and migration; [Sandbox](features/sandbox.md) and [MCP](features/mcp.md) describe
their execution and environment boundaries.
`)
	return b.String()
}
