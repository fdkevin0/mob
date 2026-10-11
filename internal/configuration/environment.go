package configuration

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/adrg/xdg"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
)

type Environment struct {
	Dir, StateDir, Addr string
	Provider            chat.Provider
	KeySource           string
	Loader              *Loader
}

type settings struct {
	DataDir  string `mapstructure:"data_dir"`
	StateDir string `mapstructure:"state_dir"`
	Addr     string `mapstructure:"addr"`
	BaseURL  string `mapstructure:"base_url"`
	Model    string `mapstructure:"model"`
	APIKey   string `mapstructure:"api_key"`
	Demo     bool   `mapstructure:"demo"`
}

// Loader holds immutable startup flags. Each read uses a fresh Viper instance;
// Viper itself is never shared between the watcher and request goroutines.
type Loader struct {
	path     string
	required bool
	flags    *pflag.FlagSet
	args     []string
}

func AddFlags(flags *pflag.FlagSet) {
	flags.String("config", "", "Configuration file (default: XDG config home/mob/config.yaml)")
	flags.String("data-dir", "", "SQLite and local token directory")
	flags.String("state-dir", "", "Background log directory")
	flags.String("addr", "", "Loopback listen address")
	flags.String("base-url", "", "OpenAI-compatible API base URL")
	flags.String("model", "", "Model name")
	flags.Bool("demo", false, "Use offline model simulation")
}

func NewLoader(flags *pflag.FlagSet) (*Loader, error) {
	l := &Loader{path: os.Getenv("MOB_CONFIG"), flags: pflag.NewFlagSet("configuration", pflag.ContinueOnError)}
	AddFlags(l.flags)
	if flags != nil {
		flags.VisitAll(func(f *pflag.Flag) {
			if f.Changed && l.flags.Lookup(f.Name) != nil {
				_ = l.flags.Set(f.Name, f.Value.String())
				l.args = append(l.args, "--"+f.Name+"="+f.Value.String())
			}
		})
		if f := flags.Lookup("config"); f != nil && f.Changed {
			l.path = f.Value.String()
		}
	}
	l.required = l.path != ""
	if l.path == "" {
		l.path = filepath.Join(xdg.ConfigHome, "mob", "config.yaml")
	}
	var err error
	l.path, err = filepath.Abs(l.path)
	return l, err
}
func (l *Loader) Path() string        { return l.path }
func (l *Loader) Arguments() []string { return append([]string(nil), l.args...) }

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
	v := viper.New()
	v.SetDefault("data_dir", defaultDataDir())
	v.SetDefault("state_dir", filepath.Join(xdg.StateHome, "mob"))
	v.SetDefault("addr", "127.0.0.1:8787")
	v.SetDefault("base_url", "https://api.deepseek.com")
	v.SetDefault("model", "deepseek-flash")
	v.SetDefault("api_key", "")
	v.SetDefault("demo", false)
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
		if runtime.GOOS != "windows" && v.GetString("api_key") != "" && mode.Perm()&0077 != 0 {
			return fail("configuration containing api_key must have owner-only permissions (chmod 600)")
		}
	}
	for _, key := range []string{"data_dir", "state_dir", "addr", "base_url", "model", "demo"} {
		if err := v.BindEnv(key, "MOB_"+strings.ToUpper(key)); err != nil {
			return Environment{}, err
		}
		if err := v.BindPFlag(key, l.flags.Lookup(strings.ReplaceAll(key, "_", "-"))); err != nil {
			return Environment{}, err
		}
	}
	if err := v.BindEnv("api_key", "MOB_API_KEY", "DEEPSEEK_API_KEY"); err != nil {
		return Environment{}, err
	}
	var data settings
	if v.UnmarshalExact(&data) != nil {
		return fail("invalid configuration fields or types (contents omitted)")
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
	if chat.ValidateProviderURL(data.BaseURL) != nil {
		return fail("base_url requires HTTPS (HTTP only for loopback), without credentials, query or fragment")
	}
	if strings.TrimSpace(data.Model) == "" || len(data.Model) > 256 || strings.ContainsAny(data.Model, "\r\n\x00") {
		return fail("model must be a nonempty name without control characters")
	}
	data.APIKey = strings.TrimSpace(data.APIKey)
	if !validAPIKey(data.APIKey) {
		return fail("api_key must contain at most 4096 printable non-space ASCII characters")
	}
	if data.DataDir == "" || data.StateDir == "" {
		return fail("data_dir and state_dir must not be empty")
	}
	data.DataDir, err = filepath.Abs(data.DataDir)
	if err != nil {
		return fail("invalid data_dir")
	}
	data.StateDir, err = filepath.Abs(data.StateDir)
	if err != nil {
		return fail("invalid state_dir")
	}
	source := ""
	if os.Getenv("MOB_API_KEY") != "" || os.Getenv("DEEPSEEK_API_KEY") != "" {
		source = "environment"
	} else if v.InConfig("api_key") {
		source = "file"
	}
	return Environment{Dir: data.DataDir, StateDir: data.StateDir, Addr: data.Addr, Provider: chat.Provider{BaseURL: data.BaseURL, APIKey: data.APIKey, Model: data.Model, Demo: data.Demo}, KeySource: source, Loader: l}, nil
}

func validAPIKey(key string) bool {
	return len(key) <= 4096 && !strings.ContainsFunc(key, func(r rune) bool { return r < 33 || r > 126 })
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
