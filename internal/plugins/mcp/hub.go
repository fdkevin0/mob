package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/fdkevin0/mob/internal/version"
)

const (
	// connectTimeout bounds starting a server and listing its tools.
	connectTimeout = 30 * time.Second
	// callTimeout bounds one tool call.
	callTimeout = 2 * time.Minute
	// maxBackoff is the longest wait before reconnecting to a server.
	maxBackoff = 5 * time.Minute
)

// Hub keeps Mob connected to the configured MCP servers and knows the tools
// each one offers.
type Hub struct {
	// Transport, when set, returns what carries requests to URL servers.
	Transport func() http.RoundTripper
	// Settings keeps the OAuth sign-ins; without it they last until Mob stops.
	Settings Settings

	// grantsMu serializes saving sign-ins.
	grantsMu sync.Mutex
	mu       sync.Mutex
	servers  Servers
	states   map[string]*state
}

// state is one server as Mob last saw it.
type state struct {
	server Server
	// session is nil while the server is not connected.
	session *sdk.ClientSession
	// tools are what the server last listed; they stay known while it
	// reconnects, so approved calls can say why they cannot run.
	tools  []*sdk.Tool
	status string
}

// Configure replaces the configured servers and reports whether they changed.
func (h *Hub) Configure(servers Servers) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if reflect.DeepEqual(h.servers, servers) {
		return false
	}
	h.servers = servers
	return true
}

// configured is the current servers.
func (h *Hub) configured() Servers {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.servers
}

// serve keeps every server in servers connected until ctx ends.
func (h *Hub) serve(ctx context.Context, servers Servers, status func(string)) {
	h.mu.Lock()
	h.states = map[string]*state{}
	for name, server := range servers {
		h.states[name] = &state{server: server, status: "connecting"}
	}
	h.mu.Unlock()
	report := func() { status(h.Status()) }
	report()
	var wg sync.WaitGroup
	for name, server := range servers {
		wg.Go(func() { h.keep(ctx, name, server, report) })
	}
	wg.Wait()
	h.mu.Lock()
	h.states = nil
	h.mu.Unlock()
}

// keep connects to one server, and reconnects with growing pauses whenever
// the connection fails or ends, until ctx ends.
func (h *Hub) keep(ctx context.Context, name string, server Server, report func()) {
	backoff := 5 * time.Second
	for ctx.Err() == nil {
		session, err := h.connect(ctx, name, server, report)
		if err == nil {
			backoff = 5 * time.Second
			// Closing the session when ctx ends stops the command.
			stop := context.AfterFunc(ctx, func() { session.Close() })
			report()
			err = session.Wait()
			stop()
			session.Close()
			h.set(name, func(s *state) { s.session = nil })
			if ctx.Err() != nil {
				return
			}
			if err == nil {
				err = fmt.Errorf("connection closed")
			}
		}
		h.set(name, func(s *state) { s.status = "reconnecting after: " + oneLine(err.Error()) })
		report()
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, maxBackoff)
	}
}

// connect starts a session with server and lists its tools.
func (h *Hub) connect(ctx context.Context, name string, server Server, report func()) (*sdk.ClientSession, error) {
	timeout := connectTimeout
	if server.OAuth {
		// Connecting may wait for the user to sign in.
		timeout += signInTimeout
	}
	connectCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: "mob", Version: version.Current}, &sdk.ClientOptions{
		ToolListChangedHandler: func(ctx context.Context, req *sdk.ToolListChangedRequest) {
			ctx, cancel := context.WithTimeout(ctx, connectTimeout)
			defer cancel()
			if tools, err := list(ctx, req.Session); err == nil {
				h.set(name, func(s *state) {
					if s.session == req.Session {
						s.tools = tools
					}
				})
			}
		},
	})
	session, err := client.Connect(connectCtx, h.transport(name, server, report), nil)
	if err != nil {
		return nil, err
	}
	tools, err := list(connectCtx, session)
	if err != nil {
		session.Close()
		return nil, err
	}
	h.set(name, func(s *state) {
		s.session, s.tools = session, tools
		s.status = fmt.Sprintf("%d tools", len(tools))
	})
	return session, nil
}

func list(ctx context.Context, session *sdk.ClientSession) ([]*sdk.Tool, error) {
	var tools []*sdk.Tool
	for tool, err := range session.Tools(ctx, nil) {
		if err != nil {
			return nil, err
		}
		tools = append(tools, tool)
	}
	return tools, nil
}

// base is what carries requests to URL servers.
func (h *Hub) base() http.RoundTripper {
	var base http.RoundTripper
	if h.Transport != nil {
		base = h.Transport()
	}
	if base == nil {
		base = http.DefaultTransport
	}
	return base
}

func (h *Hub) transport(name string, server Server, report func()) sdk.Transport {
	if server.URL != "" {
		origin, _ := url.Parse(server.URL)
		client := &http.Client{
			Transport: headers{server.Headers, origin, h.base()},
			// A redirect elsewhere could take the configured headers with
			// it, or reach a server the user did not configure.
			CheckRedirect: func(r *http.Request, via []*http.Request) error {
				if !sameOrigin(r.URL, origin) {
					return errors.New("refusing a redirect to " + r.URL.Scheme + "://" + r.URL.Host)
				}
				if len(via) >= 10 {
					return errors.New("stopped after 10 redirects")
				}
				return nil
			},
		}
		transport := &sdk.StreamableClientTransport{Endpoint: server.URL, HTTPClient: client}
		if server.OAuth {
			transport.OAuthHandler = h.signIn(name, server, report)
		}
		return transport
	}
	cmd := exec.Command(server.Command, server.Args...)
	cmd.Dir = server.Dir
	cmd.Env = append(environment(), server.Env...)
	return &sdk.CommandTransport{Command: cmd}
}

// environment is Mob's environment without its own MOB_* variables, such as
// the service token.
func environment() []string {
	var env []string
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "MOB_") {
			env = append(env, entry)
		}
	}
	return env
}

// headers adds a server's configured headers to each request to its origin.
type headers struct {
	values map[string]string
	origin *url.URL
	base   http.RoundTripper
}

func (t headers) RoundTrip(r *http.Request) (*http.Response, error) {
	if sameOrigin(r.URL, t.origin) {
		r = r.Clone(r.Context())
		for key, value := range t.values {
			r.Header.Set(key, value)
		}
	}
	return t.base.RoundTrip(r)
}

func sameOrigin(a, b *url.URL) bool {
	return a != nil && b != nil && strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}

// set changes a server's state while the hub serves it.
func (h *Hub) set(name string, change func(*state)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.states[name]; s != nil {
		change(s)
	}
}

// Status says, for each server, how many tools it offers or why it is not
// connected.
func (h *Hub) Status() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var lines []string
	for _, name := range h.servers.names() {
		status := "not running"
		if s := h.states[name]; s != nil {
			status = s.status
		}
		lines = append(lines, name+": "+status)
	}
	return strings.Join(lines, "; ")
}

func oneLine(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 300 {
		text = text[:300] + "…"
	}
	return text
}
