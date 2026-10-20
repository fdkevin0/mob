package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

const (
	// installedKey is the setting that keeps the servers the owner approved
	// installing.
	installedKey = "mcp_installed"
	// installName is the tool that asks to install a server.
	installName = "tool_install"
)

// settle is how long an install waits to say whether the server connected
// or needs the owner to sign in.
var settle = 10 * time.Second

// installed is a server installed from the catalog.
type installed struct {
	Listing Listing   `json:"listing"`
	At      time.Time `json:"at"`
	// ApprovalID is the approval that installed it.
	ApprovalID string `json:"approvalId"`
}

// server is how Mob reaches an installed server: its URL, signing in with
// OAuth when it asks.
func (i installed) server() Server { return Server{URL: i.Listing.URL, OAuth: true} }

// installRequest is an install as the owner approves it.
type installRequest struct {
	// Server is the name its tools will carry.
	Server      string `json:"server"`
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Version     string `json:"version,omitempty"`
	URL         string `json:"url"`
	Repository  string `json:"repository,omitempty"`
	Source      string `json:"source"`
	Description string `json:"description,omitempty"`
}

// installs are the installed servers by name.
func (h *Hub) installs() map[string]installed {
	list := map[string]installed{}
	if h.Settings != nil {
		h.Settings.Setting(installedKey, &list)
	}
	return list
}

// Configure replaces the servers config.yaml lists and reports whether the
// servers Mob connects to changed. Installed servers join them under names
// config.yaml does not use.
func (h *Hub) Configure(servers Servers) bool {
	installs := h.installs()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.config = servers
	return h.merge(installs)
}

// merge sets the servers from config.yaml and installs, and reports whether
// they changed. Call it with h.mu held.
func (h *Hub) merge(installs map[string]installed) bool {
	merged := maps.Clone(h.config)
	for name, i := range installs {
		if _, taken := merged[name]; !taken {
			if merged == nil {
				merged = Servers{}
			}
			merged[name] = i.server()
		}
	}
	if equalServers(h.servers, merged) {
		return false
	}
	h.servers = merged
	return true
}

// Installed reports whether a server came from the catalog.
func (h *Hub) Installed(name string) bool {
	h.mu.Lock()
	_, configured := h.config[name]
	h.mu.Unlock()
	_, ok := h.installs()[name]
	return ok && !configured
}

// install keeps a server the owner approved and connects to it.
func (h *Hub) install(r installRequest, approvalID string) error {
	if h.Settings == nil {
		return errors.New("installed servers cannot be kept")
	}
	h.installMu.Lock()
	installs := h.installs()
	if _, ok := installs[r.Server]; ok {
		h.installMu.Unlock()
		return fmt.Errorf("a server named %s is installed already", r.Server)
	}
	installs[r.Server] = installed{Listing: Listing{Name: r.Name, Title: r.Title, Description: r.Description, Version: r.Version, Repository: r.Repository, URL: r.URL, Source: r.Source}, At: time.Now().UTC(), ApprovalID: approvalID}
	err := h.Settings.SaveSetting(installedKey, installs)
	h.installMu.Unlock()
	if err != nil {
		return err
	}
	return h.changed(installs)
}

// Remove forgets an installed server and its sign-in.
func (h *Hub) Remove(name string) error {
	if !h.Installed(name) {
		return fmt.Errorf("%s is not an installed server", name)
	}
	h.installMu.Lock()
	installs := h.installs()
	delete(installs, name)
	err := h.Settings.SaveSetting(installedKey, installs)
	h.installMu.Unlock()
	if err != nil {
		return err
	}
	if err := h.saveGrant(name, nil); err != nil {
		return err
	}
	return h.changed(installs)
}

// changed applies installs and reconnects when the servers changed.
func (h *Hub) changed(installs map[string]installed) error {
	h.mu.Lock()
	changed := h.merge(installs)
	h.mu.Unlock()
	if changed && h.Changed != nil {
		return h.Changed()
	}
	return nil
}

// nameWords are left out of a server's name: nearly every URL has them.
var nameWords = map[string]bool{"mcp": true, "www": true, "api": true, "sse": true, "v1": true, "com": true, "io": true, "dev": true, "app": true, "net": true, "org": true}

var notName = regexp.MustCompile(`[^a-z0-9]+`)

// localName is the name an installed server's tools carry: words of its
// URL's host, most significant first, then of its path, unused by servers.
func localName(raw string, servers Servers) string {
	u, _ := url.Parse(raw)
	var words []string
	labels := strings.Split(strings.ToLower(u.Hostname()), ".")
	for i := len(labels) - 1; i >= 0; i-- {
		words = append(words, labels[i])
	}
	words = append(words, strings.Split(strings.ToLower(u.Path), "/")...)
	var parts []string
	for _, w := range words {
		w = strings.Trim(notName.ReplaceAllString(w, "-"), "-")
		if w != "" && !nameWords[w] && !slices.Contains(parts, w) {
			parts = append(parts, w)
		}
	}
	name := strings.Trim(strings.Join(parts, "-"), "-")
	if len(name) > 28 {
		name = strings.Trim(name[:28], "-")
	}
	if name == "" {
		name = "server"
	}
	unique := name
	for n := 2; ; n++ {
		if _, taken := servers[unique]; !taken {
			return unique
		}
		unique = name + "-" + strconv.Itoa(n)
	}
}

// InstallTool asks the owner to install a server from the catalog. It is
// offered while the catalog has servers to install.
func (h *Hub) InstallTool() chat.Tool {
	return chat.Tool{
		Tool: llm.Tool{
			Name:        installName,
			Description: "Ask the owner to install a remote MCP server that tool_search found, by its URL. Stops the turn until the owner decides; once installed and connected, its tools are found with tool_search.",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{
				"url": map[string]any{"type": "string", "description": "The server's URL, as tool_search gave it"},
			}, "required": []string{"url"}, "additionalProperties": false},
		},
		OwnerOnly: true,
		Available: func() bool { return len(h.Listings()) > 0 },
		Run: func(_ context.Context, call chat.ToolCall) (any, error) {
			u, _ := call.Input["url"].(string)
			l, ok := h.listing(u)
			if !ok {
				return nil, errors.New("no server in the catalog has that URL; find one with tool_search")
			}
			if header := l.needs(); header != "" {
				return nil, fmt.Errorf("this server needs the %s header; the owner adds it under mcp_servers in config.yaml", header)
			}
			h.mu.Lock()
			name := localName(l.URL, h.servers)
			h.mu.Unlock()
			return nil, call.RequestApproval(installRequest{Server: name, Name: l.Name, Title: l.Title, Version: l.Version, URL: l.URL, Repository: l.Repository, Source: l.Source, Description: brief(l.Description)})
		},
		Approved: func(ctx context.Context, call chat.ApprovedCall) (any, error) {
			var r installRequest
			if err := json.Unmarshal(call.Input, &r); err != nil {
				return nil, err
			}
			h.mu.Lock()
			_, taken := h.servers[r.Server]
			h.mu.Unlock()
			if taken || !serverName.MatchString(r.Server) {
				return nil, fmt.Errorf("the name %s is taken now; ask again", r.Server)
			}
			if err := h.install(r, call.ApprovalID); err != nil {
				return nil, err
			}
			return map[string]string{"installed": r.Server, "status": h.await(ctx, r.Server)}, nil
		},
		// Remembering an install covers installing the same server again.
		Scope: func(input json.RawMessage) string {
			var r installRequest
			json.Unmarshal(input, &r)
			return r.URL
		},
	}
}

// await waits a little for a new server to connect or to ask the owner to
// sign in, and says which.
func (h *Hub) await(ctx context.Context, name string) string {
	deadline := time.Now().Add(settle)
	for {
		h.mu.Lock()
		status := "connecting"
		if s := h.states[name]; s != nil {
			status = s.status
		}
		h.mu.Unlock()
		if strings.HasPrefix(status, "sign in to connect: ") {
			return "The owner must sign in before its tools can be used: " + strings.TrimPrefix(status, "sign in to connect: ") + " Give them the link and say: " + SignInHint
		}
		if strings.HasSuffix(status, " tools") || time.Now().After(deadline) {
			return status + "; its tools are found with tool_search"
		}
		select {
		case <-ctx.Done():
			return status
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func brief(s string) string {
	if r := []rune(strings.TrimSpace(s)); len(r) > 300 {
		return string(r[:300]) + "…"
	}
	return strings.TrimSpace(s)
}
