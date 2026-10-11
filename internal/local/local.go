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
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
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
	stopWatch   func()
	configMu    sync.RWMutex
	configError string
}

func LoadConfig() (Config, error) { return configuration.Load() }

func Credentials(c Config) (Connection, error) {
	token := os.Getenv("MOB_TOKEN")
	if token == "" {
		raw, err := os.ReadFile(filepath.Join(c.Dir, "token"))
		if err != nil {
			return Connection{}, err
		}
		token = strings.TrimSpace(string(raw))
	}
	if len(token) < 32 {
		return Connection{}, errors.New("MOB_TOKEN must contain at least 32 characters")
	}
	return Connection{"http://" + c.Addr, token}, nil
}

func Start(c Config, assets fs.FS) (*App, error)       { return start(c, assets, false) }
func StartDaemon(c Config, assets fs.FS) (*App, error) { return start(c, assets, true) }
func start(c Config, assets fs.FS, background bool) (*App, error) {
	// Bind first: another local service must not have its live DB marked interrupted.
	listener, err := net.Listen("tcp", c.Addr)
	if err != nil {
		return nil, err
	}
	store, err := chat.OpenStore(filepath.Join(c.Dir, "mob.sqlite"))
	if err != nil {
		listener.Close()
		return nil, err
	}
	cleanup := func() { listener.Close(); store.Close() }
	if os.Getenv("MOB_TOKEN") == "" {
		path := filepath.Join(c.Dir, "token")
		file, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e == nil {
			_, e = file.WriteString(chat.NewID() + chat.NewID())
			e = errors.Join(e, file.Close())
		} else if errors.Is(e, os.ErrExist) {
			e = os.Chmod(path, 0600)
		}
		if e != nil {
			cleanup()
			return nil, e
		}
	}
	connection, err := Credentials(c)
	if err != nil {
		cleanup()
		return nil, err
	}
	connection.URL = "http://" + listener.Addr().String()
	keySource := c.KeySource
	if keySource == "" && c.Provider.APIKey != "" {
		keySource = "environment"
	}
	server := app.NewServer(store, c.Provider, connection.Token)
	server.Configuration.KeySource = keySource
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
		a.stopWatch, err = c.Loader.Watch(context.Background(), func(next configuration.Environment) error {
			if next.Dir != c.Dir || next.StateDir != c.StateDir || next.Addr != c.Addr {
				return errors.New("data_dir, state_dir and addr changes require a restart; current configuration retained")
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
		if err != nil {
			server.Close()
			cleanup()
			return nil, err
		}
	}
	go func() {
		if e := httpServer.Serve(listener); e != nil && !errors.Is(e, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "HTTP server: %v\n", e)
		}
	}()
	return a, nil
}

func (a *App) Close() error {
	if a.stopWatch != nil {
		a.stopWatch()
	}
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
	return a.configError
}
