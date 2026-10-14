// Package local owns the single-user process lifecycle shared by CLI and desktop.
package local

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/app"
	"github.com/fdkevin0/mob/internal/catalog"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/plugins/skills"
	"github.com/fdkevin0/mob/internal/provider"
)

type Connection struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}
type Config = configuration.Environment
type App struct {
	Done        <-chan struct{}
	Connection  Connection
	Server      *app.Server
	http        *http.Server
	store       *chat.Store
	stopWatch   []func()
	configMu    sync.RWMutex
	configError string
	providers   string
}

func LoadConfig() (Config, error) { return configuration.Load() }

// newCatalog is replaced by tests, which must not fetch models.dev.
var newCatalog = catalog.Default

func Credentials(c Config) (Connection, error) {
	token := c.Token
	if token == "" {
		raw, err := os.ReadFile(filepath.Join(c.Dir, "token"))
		if err != nil {
			return Connection{}, err
		}
		token = strings.TrimSpace(string(raw))
	}
	if len(token) < 32 {
		return Connection{}, errors.New("token must contain at least 32 bytes")
	}
	return Connection{"http://" + c.Addr, token}, nil
}

// openStore takes the database and reads the token under the token lock, so an
// offline mob token rotate never replaces the file between the two.
func openStore(c Config) (*chat.Store, Connection, error) {
	unlock, err := lockToken(c.Dir)
	if err != nil {
		return nil, Connection{}, err
	}
	defer unlock()
	store, err := chat.OpenStore(storePath(c))
	if err != nil {
		return nil, Connection{}, err
	}
	if c.Token == "" {
		path := filepath.Join(c.Dir, "token")
		file, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e == nil {
			_, e = file.WriteString(chat.NewID() + chat.NewID())
			e = errors.Join(e, file.Close())
		} else if errors.Is(e, os.ErrExist) {
			e = os.Chmod(path, 0600)
		}
		if e != nil {
			store.Close()
			return nil, Connection{}, e
		}
	}
	connection, err := Credentials(c)
	if err != nil {
		store.Close()
		return nil, Connection{}, err
	}
	return store, connection, nil
}

func storePath(c Config) string { return filepath.Join(c.Dir, "mob.sqlite") }

func Start(c Config, assets fs.FS) (*App, error)       { return start(c, assets, false) }
func StartDaemon(c Config, assets fs.FS) (*App, error) { return start(c, assets, true) }
func start(c Config, assets fs.FS, background bool) (*App, error) {
	// Bind first: another local service must not have its live DB marked interrupted.
	listener, err := net.Listen("tcp", c.Addr)
	if err != nil {
		return nil, err
	}
	store, connection, err := openStore(c)
	if err != nil {
		listener.Close()
		return nil, err
	}
	cleanup := func() { listener.Close(); store.Close() }
	connection.URL = "http://" + listener.Addr().String()
	providersPath := ""
	if c.Loader != nil {
		providersPath = c.Loader.ProvidersPath()
	}
	models := newCatalog()
	registry, err := provider.Open(providersPath, models, provider.Initial())
	if err != nil {
		cleanup()
		return nil, err
	}
	registry.Demo = c.Demo
	server := app.NewServer(store, registry, connection.Token)
	if c.Token == "" {
		server.PersistToken = func(token string) error { return writeToken(c.Dir, token) }
	}
	server.SetToolSteps(c.MaxToolSteps)
	server.SetWebURL(c.WebURL)
	server.MCP.Configure(c.MCPServers)
	server.Skills.Roots = skills.Roots(c.Dir)
	if err := server.ApplySandbox(c.Sandbox, c.Dir); err != nil {
		cleanup()
		return nil, err
	}
	done := make(chan struct{})
	var shutdown sync.Once
	if background {
		server.Shutdown = func() { shutdown.Do(func() { close(done) }) }
	}
	httpServer := &http.Server{Handler: server.Handler(assets), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	a := &App{Done: done, Connection: connection, Server: server, http: httpServer, store: store}
	if err := server.StartPlugins(); err != nil {
		cleanup()
		return nil, err
	}
	server.ConfigurationError = a.ConfigError
	if c.Loader != nil {
		fresh, stopFresh := context.WithCancel(context.Background())
		a.stopWatch = append(a.stopWatch, stopFresh)
		go models.KeepFresh(fresh, func(err error) { log.Printf("Model catalog refresh failed: %s", err) })
		stop, err := c.Loader.Watch(context.Background(), func(next configuration.Environment) error {
			if next.Dir != c.Dir || next.StateDir != c.StateDir || next.Addr != c.Addr || next.Token != c.Token {
				return errors.New("data_dir, state_dir, addr and token changes require a restart; current configuration retained")
			}
			if next.Gateway.URL != c.Gateway.URL || c.Gateway.URL != "" && (next.Gateway.NodeID != c.Gateway.NodeID || next.Gateway.Token != c.Gateway.Token) {
				return errors.New("active gateway connection changes require a restart; current configuration retained")
			}
			return server.ReloadConfiguration(next)
		}, func(err error) {
			a.configMu.Lock()
			a.configError = ""
			if err != nil {
				a.configError = err.Error()
			}
			a.configMu.Unlock()
			if err != nil {
				log.Printf("Configuration reload rejected: %s", err)
			}
		})
		if err == nil {
			a.stopWatch = append(a.stopWatch, stop)
			stop, err = configuration.WatchFile(context.Background(), providersPath, false, registry.Reload, func(err error) {
				a.configMu.Lock()
				a.providers = ""
				if err != nil {
					a.providers = err.Error() + "; current providers retained"
				}
				a.configMu.Unlock()
				if err != nil {
					log.Printf("providers.json reload rejected: %s", err)
				}
			})
		}
		if err != nil {
			a.stopAll()
			server.Close()
			cleanup()
			return nil, err
		}
		a.stopWatch = append(a.stopWatch, stop)
	}
	go func() {
		if e := httpServer.Serve(listener); e != nil && !errors.Is(e, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "HTTP server: %v\n", e)
		}
	}()
	return a, nil
}

func (a *App) stopAll() {
	for _, stop := range a.stopWatch {
		stop()
	}
	a.stopWatch = nil
}

func (a *App) Close() error {
	a.stopAll()
	a.Server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := a.http.Shutdown(ctx)
	if err != nil {
		_ = a.http.Close()
	}
	return errors.Join(err, a.store.Close())
}

func Reachable(c Connection) bool {
	req, err := http.NewRequest("GET", c.URL+"/api/config", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	client := http.Client{Timeout: time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

// ConnectOrStart reuses an authenticated service, or owns one until the UI exits.
func ConnectOrStart(c Config, assets fs.FS) (Connection, func(), error) {
	connection, err := Credentials(c)
	if err == nil && Reachable(connection) {
		return connection, func() {}, nil
	}
	app, err := Start(c, assets)
	if err != nil {
		return Connection{}, func() {}, err
	}
	return app.Connection, func() { _ = app.Close() }, nil
}

// ConfigError is a sanitized diagnostic; it never contains config values.
func (a *App) ConfigError() string {
	a.configMu.RLock()
	defer a.configMu.RUnlock()
	return strings.Trim(a.configError+"\n"+a.providers, "\n")
}

// writeToken replaces the token file atomically so readers never see a partial token.
func writeToken(dir, token string) error {
	file, err := os.CreateTemp(dir, ".token-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.WriteString(token)
	err = errors.Join(err, file.Chmod(0600), file.Close())
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(dir, "token"))
}
