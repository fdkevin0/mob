package configuration

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/adrg/xdg"
	"github.com/fdkevin0/mob/internal/plugins/mcp"
	"github.com/fdkevin0/mob/internal/sandbox"
	"github.com/spf13/pflag"
)

type Environment struct {
	Dir, StateDir, Addr string
	Token               string
	Gateway             GatewaySettings
	// Demo makes the offline model the default.
	Demo bool
	// Sandbox is where Mob runs commands for the model, isolated from the host.
	Sandbox sandbox.Settings
	// MaxToolSteps bounds the model calls one turn makes while it uses tools.
	MaxToolSteps int
	// MCPServers are the MCP servers whose tools the model may use.
	MCPServers mcp.Servers
	// WebURL is the public web UI mob open --web signs in to; empty turns it off.
	WebURL string
	Loader *Loader
}

type GatewaySettings struct {
	URL    string `mapstructure:"url"`
	NodeID string `mapstructure:"node_id"`
	Addr   string `mapstructure:"addr"`
	Token  string `mapstructure:"token"`
}

type settings struct {
	Token    string           `mapstructure:"token"`
	Gateway  GatewaySettings  `mapstructure:"gateway"`
	DataDir  string           `mapstructure:"data_dir"`
	StateDir string           `mapstructure:"state_dir"`
	Addr     string           `mapstructure:"addr"`
	Demo     bool             `mapstructure:"demo"`
	Sandbox  sandbox.Settings `mapstructure:"sandbox"`
	// MaxToolSteps is max_tool_steps, 1 to MaxToolSteps.
	MaxToolSteps int         `mapstructure:"max_tool_steps"`
	MCPServers   mcp.Servers `mapstructure:"mcp_servers"`
	WebURL       string      `mapstructure:"web_url"`
}

// MaxToolSteps is the most max_tool_steps may allow; DefaultToolSteps is used
// when the configuration does not say.
const (
	MaxToolSteps     = 100
	DefaultToolSteps = 20
)

// DefaultWebURL is the public web UI deployed to Cloudflare Workers from this
// repository (wrangler.jsonc). It holds no data: the page talks to the Mob
// running on the computer whose mob open --web link it was given.
const DefaultWebURL = "https://mob.fdkevin.cloud"

// WebOrigin returns the origin a web_url's pages send, or "" when it is empty.
// The page must be served over https, or over http from a loopback host while
// developing it.
func WebOrigin(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	invalid := errors.New("web_url must be an https URL without credentials, query or fragment")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") {
		return "", invalid
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	switch {
	case scheme == "https":
	case scheme == "http" && (host == "localhost" || ip != nil && ip.IsLoopback()):
	default:
		return "", invalid
	}
	switch port := u.Port(); {
	case port == "" || scheme == "https" && port == "443" || scheme == "http" && port == "80":
		if ip != nil && ip.To4() == nil {
			host = "[" + host + "]"
		}
		return scheme + "://" + host, nil
	default:
		return scheme + "://" + net.JoinHostPort(host, port), nil
	}
}

// Loader holds immutable startup flags. Each read uses a fresh Viper instance;
// Viper itself is never shared between the watcher and request goroutines.
type Loader struct {
	path     string
	required bool
	flags    *pflag.FlagSet
	args     []string
}

func NewLoader(flags *pflag.FlagSet) (*Loader, error) {
	l := &Loader{flags: pflag.NewFlagSet("configuration", pflag.ContinueOnError)}
	AddFlags(l.flags)
	if flags != nil {
		for _, o := range options() {
			f := flags.Lookup(o.flag())
			if f == nil || !f.Changed {
				continue
			}
			if err := l.flags.Set(f.Name, f.Value.String()); err != nil {
				return nil, errors.New("invalid configuration flag: " + f.Name)
			}
		}
		l.flags.Visit(func(f *pflag.Flag) {
			secret := false
			for _, o := range options() {
				if o.flag() == f.Name {
					secret = o.secret
					break
				}
			}
			if !secret || f.Value.String() == "" {
				l.args = append(l.args, "--"+f.Name+"="+f.Value.String())
			}
		})
	}
	v, err := configuredViper(l.flags, true)
	if err != nil {
		return nil, err
	}
	l.path = v.GetString("config")
	l.required = l.path != ""
	if l.path == "" {
		l.path = filepath.Join(xdg.ConfigHome, "mob", "config.yaml")
	}
	l.path, err = filepath.Abs(l.path)
	return l, err
}
func (l *Loader) Path() string { return l.path }

// ProvidersPath is providers.json, beside the configuration file.
func (l *Loader) ProvidersPath() string { return filepath.Join(filepath.Dir(l.path), "providers.json") }
func (l *Loader) Arguments() []string   { return append([]string(nil), l.args...) }

func defaultDataDir() string {
	dir := filepath.Join(xdg.DataHome, "mob")
	// Reuse an existing pre-XDG database; never silently move or abandon history.
	if old, err := os.UserConfigDir(); err == nil {
		old = filepath.Join(old, "mob")
		if _, err = os.Stat(filepath.Join(old, "mob.sqlite")); err == nil {
			return old
		}
	}
	return dir
}

func (l *Loader) Read() (Environment, error) { return l.read(l.required) }
func (l *Loader) read(required bool) (Environment, error) {
	fail := func(message string) (Environment, error) { return Environment{}, errors.New(message) }
	v, err := configuredViper(l.flags, false)
	if err != nil {
		return Environment{}, err
	}
	raw, mode, err := readConfigFile(l.path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) || required {
			return fail("cannot safely read configuration file")
		}
	} else {
		format := strings.TrimPrefix(strings.ToLower(filepath.Ext(l.path)), ".")
		if format == "yml" {
			format = "yaml"
		}
		if format != "yaml" && format != "json" && format != "toml" {
			return fail("configuration must be YAML, JSON or TOML")
		}
		v.SetConfigType(format)
		if v.ReadConfig(bytes.NewReader(raw)) != nil {
			return fail("invalid configuration syntax (contents omitted)")
		}
		if runtime.GOOS != "windows" && mode.Perm()&0022 != 0 {
			return fail("configuration must not be writable by group or others")
		}
	}
	if v.InConfig("config") {
		return fail("config is a file selector, not a configuration field")
	}
	if value, ok := v.Get("mcp_servers").(string); ok {
		var servers map[string]any
		if json.Unmarshal([]byte(value), &servers) != nil || servers == nil {
			return fail("mcp_servers must be a JSON object (contents omitted)")
		}
		v.Set("mcp_servers", servers)
	}
	var data settings
	if v.UnmarshalExact(&data) != nil {
		return fail("invalid configuration fields or types (contents omitted); model providers live in providers.json")
	}
	host, port, err := net.SplitHostPort(data.Addr)
	if err != nil {
		return fail("addr must be a loopback IP and port")
	}
	ip := net.ParseIP(host)
	number, err := strconv.Atoi(port)
	if ip == nil || !ip.IsLoopback() || err != nil || number < 0 || number > 65535 {
		return fail("addr must be a loopback IP and valid port")
	}
	if data.DataDir == "" || data.StateDir == "" {
		return fail("data_dir and state_dir must not be empty")
	}
	if data.MaxToolSteps < 1 || data.MaxToolSteps > MaxToolSteps {
		return fail("max_tool_steps must be 1 to " + strconv.Itoa(MaxToolSteps))
	}
	if data.Token != "" && len(data.Token) < 32 {
		return fail("token must contain at least 32 bytes")
	}
	if mode != 0 && runtime.GOOS != "windows" && mode.Perm()&0077 != 0 && (v.InConfig("token") || v.InConfig("gateway.token")) {
		return fail("configuration with tokens must be owner-only (chmod 600)")
	}
	if _, port, err := net.SplitHostPort(data.Gateway.Addr); err != nil {
		return fail("gateway.addr must be a host and port")
	} else if n, err := strconv.Atoi(port); err != nil || n < 0 || n > 65535 {
		return fail("gateway.addr must use a valid port")
	}
	if data.Gateway.URL != "" {
		u, err := url.Parse(data.Gateway.URL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return fail("gateway.url must be an http or https URL")
		}
	}
	if _, err := WebOrigin(data.WebURL); err != nil {
		return Environment{}, err
	}
	if err := data.Sandbox.Validate(); err != nil {
		return Environment{}, err
	}
	if err := data.MCPServers.Validate(); err != nil {
		return Environment{}, err
	}
	data.DataDir, err = filepath.Abs(data.DataDir)
	if err != nil {
		return fail("invalid data_dir")
	}
	data.StateDir, err = filepath.Abs(data.StateDir)
	if err != nil {
		return fail("invalid state_dir")
	}
	return Environment{Token: data.Token, Gateway: data.Gateway, Dir: data.DataDir, StateDir: data.StateDir, Addr: data.Addr, Demo: data.Demo, Sandbox: data.Sandbox, MaxToolSteps: data.MaxToolSteps, MCPServers: data.MCPServers, WebURL: data.WebURL, Loader: l}, nil
}

func readConfigFile(path string) ([]byte, os.FileMode, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return nil, 0, errors.New("configuration must be a regular file of at most 64 KiB")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !os.SameFile(info, opened) {
		return nil, 0, errors.New("configuration changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil {
		return nil, 0, err
	}
	after, err := file.Stat()
	if err != nil {
		return nil, 0, err
	}
	if len(raw) > 64<<10 || opened.Size() != after.Size() || !opened.ModTime().Equal(after.ModTime()) {
		return nil, 0, errors.New("configuration changed while reading")
	}
	return raw, after.Mode(), nil
}

func Load() (Environment, error) {
	loader, err := NewLoader(nil)
	if err != nil {
		return Environment{}, err
	}
	return loader.Read()
}
