package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
)

// DefaultRegistry is the official MCP Registry.
const DefaultRegistry = "https://registry.modelcontextprotocol.io"

const (
	// catalogKey is the setting that keeps what the registry last listed.
	catalogKey = "mcp_catalog"
	// refreshAfter is how old the registry's listing may grow before Mob
	// asks again.
	refreshAfter = 24 * time.Hour
	// registryPages bounds the pages read for one namespace.
	registryPages = 20
	// maxListings bounds what the catalog keeps from the registry.
	maxListings = 500
)

// retryAfter is how long Mob waits to ask a registry again after it failed.
var retryAfter = time.Hour

// Registry is where the catalog finds remote servers besides Mob's own list.
type Registry struct {
	URL string
	// Namespaces are globs of registry names, such as com.cloudflare.mcp/*,
	// whose remote servers the model may find and install. Without any the
	// catalog is Mob's own list, and Mob asks no registry.
	Namespaces []string
}

// Validate refuses a registry that is not an https URL, or a namespace that
// is not a glob of names.
func (r Registry) Validate() error {
	if len(r.Namespaces) == 0 {
		return nil
	}
	u, err := url.Parse(r.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return errors.New("mcp_registry.url must be an https URL")
	}
	for _, glob := range r.Namespaces {
		if _, err := path.Match(glob, ""); err != nil || !strings.Contains(glob, "/") {
			return fmt.Errorf("mcp_registry.namespaces: %q is not a glob of names such as com.example/*", glob)
		}
	}
	return nil
}

// Listing is a remote server the model may find and ask to install.
type Listing struct {
	// Name is the server's name in the registry, or Mob's for its own.
	Name        string   `json:"name"`
	Title       string   `json:"title,omitempty"`
	Description string   `json:"description"`
	Version     string   `json:"version,omitempty"`
	Repository  string   `json:"repository,omitempty"`
	URL         string   `json:"url"`
	Headers     []Header `json:"headers,omitempty"`
	// Source is the registry it came from, or "mob" for Mob's own list.
	Source string `json:"source"`
}

// Header is one header a server takes.
type Header struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
	Secret      bool   `json:"secret,omitempty"`
}

// curated are the servers every catalog offers. They sign in with OAuth.
var curated = []Listing{
	{Name: "cloudflare", Title: "Cloudflare API", Description: "The whole Cloudflare API: search its endpoints, then run code against them, for DNS, Workers, R2, D1, zones and account settings.", URL: "https://mcp.cloudflare.com/mcp", Source: "mob"},
	{Name: "cloudflare-docs", Title: "Cloudflare documentation", Description: "Search Cloudflare's developer documentation.", URL: "https://docs.mcp.cloudflare.com/mcp", Repository: "https://github.com/cloudflare/mcp-server-cloudflare", Source: "mob"},
	{Name: "cloudflare-browser", Title: "Cloudflare Browser Rendering", Description: "Fetch web pages as Markdown or HTML and take screenshots with Cloudflare's headless browsers.", URL: "https://browser.mcp.cloudflare.com/mcp", Repository: "https://github.com/cloudflare/mcp-server-cloudflare", Source: "mob"},
	{Name: "cloudflare-radar", Title: "Cloudflare Radar", Description: "Internet traffic trends, outages, attacks and domain rankings from Cloudflare Radar.", URL: "https://radar.mcp.cloudflare.com/mcp", Repository: "https://github.com/cloudflare/mcp-server-cloudflare", Source: "mob"},
}

// catalog is what the registry last listed for the namespaces asked.
type catalog struct {
	Registry Registry  `json:"registry"`
	Synced   time.Time `json:"synced"`
	Listings []Listing `json:"listings"`
}

// ConfigureRegistry sets where the catalog looks; a change asks the registry
// again when the catalog is next read.
func (h *Hub) ConfigureRegistry(r Registry) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.registry = r
}

// Registry is where the catalog looks.
func (h *Hub) Registry() Registry {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.registry
}

func sameRegistry(a, b Registry) bool {
	return a.URL == b.URL && slices.Equal(a.Namespaces, b.Namespaces)
}

// listed is what the registry last listed, read from the setting once.
func (h *Hub) listed() catalog {
	h.mu.Lock()
	c := h.cached
	h.mu.Unlock()
	if c != nil {
		return *c
	}
	var loaded catalog
	if h.Settings != nil {
		h.Settings.Setting(catalogKey, &loaded)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cached == nil {
		h.cached = &loaded
	}
	return *h.cached
}

// Listings are the servers the model may install: Mob's own, then those the
// registry listed, without any that are configured or installed already.
func (h *Hub) Listings() []Listing {
	h.mu.Lock()
	registry, servers := h.registry, h.servers
	h.mu.Unlock()
	cached := h.listed()
	current := len(registry.Namespaces) > 0 && sameRegistry(cached.Registry, registry)
	if len(registry.Namespaces) > 0 && (!current || time.Since(cached.Synced) > refreshAfter) {
		h.refresh(registry)
	}
	if !current {
		cached.Listings = nil
	}
	taken := map[string]bool{}
	for _, s := range servers {
		if s.URL != "" {
			taken[s.URL] = true
		}
	}
	var list []Listing
	for _, l := range append(slices.Clone(curated), cached.Listings...) {
		if !taken[l.URL] {
			taken[l.URL] = true
			list = append(list, l)
		}
	}
	return list
}

// listing is the catalog's listing at u.
func (h *Hub) listing(u string) (Listing, bool) {
	list := h.Listings()
	i := slices.IndexFunc(list, func(l Listing) bool { return l.URL == u })
	if i < 0 {
		return Listing{}, false
	}
	return list[i], true
}

// refresh asks the registry for its listings in the background, once at a
// time, and keeps them. After a failure it waits retryAfter before asking
// the same registry again.
func (h *Hub) refresh(r Registry) {
	h.mu.Lock()
	if h.refreshing || sameRegistry(h.tried, r) && time.Since(h.triedAt) < retryAfter {
		h.mu.Unlock()
		return
	}
	h.refreshing, h.tried, h.triedAt = true, r, time.Now()
	h.mu.Unlock()
	go func() {
		defer func() {
			h.mu.Lock()
			h.refreshing = false
			h.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		listings, err := fetchRegistry(ctx, &http.Client{Transport: h.base()}, r)
		if err != nil {
			// What was listed before stays.
			return
		}
		c := catalog{Registry: r, Synced: time.Now(), Listings: listings}
		h.mu.Lock()
		h.cached = &c
		h.mu.Unlock()
		if h.Settings != nil {
			h.Settings.SaveSetting(catalogKey, c)
		}
	}()
}

// registryPage is one page of the registry's list of servers.
type registryPage struct {
	Servers []struct {
		Server struct {
			Name        string `json:"name"`
			Title       string `json:"title"`
			Description string `json:"description"`
			Version     string `json:"version"`
			Status      string `json:"status"`
			Repository  struct {
				URL string `json:"url"`
			} `json:"repository"`
			Remotes []struct {
				Type    string `json:"type"`
				URL     string `json:"url"`
				Headers []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
					IsRequired  bool   `json:"isRequired"`
					IsSecret    bool   `json:"isSecret"`
				} `json:"headers"`
			} `json:"remotes"`
		} `json:"server"`
		Meta struct {
			Official struct {
				Status string `json:"status"`
			} `json:"io.modelcontextprotocol.registry/official"`
		} `json:"_meta"`
	} `json:"servers"`
	Metadata struct {
		NextCursor string `json:"nextCursor"`
	} `json:"metadata"`
}

// fetchRegistry lists the remote servers whose names match the registry's
// namespaces: the latest version of each active server, one listing for
// each of its Streamable HTTP endpoints served over https.
func fetchRegistry(ctx context.Context, client *http.Client, r Registry) ([]Listing, error) {
	var list []Listing
	seen := map[string]bool{}
	for _, glob := range r.Namespaces {
		// The registry searches names by substring: the glob's literal start.
		prefix := glob[:strings.IndexAny(glob+"*", "*?[\\")]
		cursor := ""
		for range registryPages {
			query := url.Values{"search": {prefix}, "version": {"latest"}, "limit": {"100"}}
			if cursor != "" {
				query.Set("cursor", cursor)
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(r.URL, "/")+"/v0.1/servers?"+query.Encode(), nil)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Accept", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				return nil, err
			}
			var page registryPage
			err = json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 8<<20)).Decode(&page)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return nil, fmt.Errorf("the registry answered %s", resp.Status)
			}
			if err != nil {
				return nil, err
			}
			for _, entry := range page.Servers {
				s := entry.Server
				status := entry.Meta.Official.Status
				if status == "" {
					status = s.Status
				}
				if ok, _ := path.Match(glob, s.Name); !ok || status != "" && status != "active" {
					continue
				}
				for _, remote := range s.Remotes {
					u, err := url.Parse(remote.URL)
					if remote.Type != "streamable-http" || err != nil || u.Scheme != "https" || u.Host == "" || seen[remote.URL] {
						continue
					}
					seen[remote.URL] = true
					l := Listing{Name: s.Name, Title: s.Title, Description: s.Description, Version: s.Version, Repository: s.Repository.URL, URL: remote.URL, Source: r.URL}
					for _, h := range remote.Headers {
						l.Headers = append(l.Headers, Header{Name: h.Name, Description: h.Description, Required: h.IsRequired, Secret: h.IsSecret})
					}
					list = append(list, l)
					if len(list) == maxListings {
						return list, nil
					}
				}
			}
			cursor = page.Metadata.NextCursor
			if cursor == "" {
				break
			}
		}
	}
	return list, nil
}

// needs is the header a listing requires, if any: Mob cannot ask the model
// for its value, so the owner configures such a server themselves.
func (l Listing) needs() string {
	for _, h := range l.Headers {
		if h.Required {
			return h.Name
		}
	}
	return ""
}

// Entries are the servers the catalog offers, for tool_search to find.
func (h *Hub) Entries() []chat.Entry {
	var entries []chat.Entry
	for _, l := range h.Listings() {
		name := l.Name
		if host := hostOf(l.URL); !strings.Contains(name, host) {
			name += " (" + host + ")"
		}
		description := strings.TrimSpace(strings.Join([]string{l.Title, l.Description}, ". "))
		use := fmt.Sprintf("Not installed. To use it, call tool_install with url %q; the owner approves the install.", l.URL)
		if header := l.needs(); header != "" {
			use = fmt.Sprintf("Not installed. It needs the %s header, so the owner adds it under mcp_servers in config.yaml with url %q.", header, l.URL)
		}
		entries = append(entries, chat.Entry{Kind: "MCP server", Name: name, Description: description + " " + l.URL, Use: use, OwnerOnly: true})
	}
	return entries
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Host
}
