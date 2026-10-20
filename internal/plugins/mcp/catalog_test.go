package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

// registryServer serves two pages of registry listings and records what was
// searched for.
func registryServer(t *testing.T, searched *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0.1/servers" || r.URL.Query().Get("version") != "latest" {
			http.NotFound(w, r)
			return
		}
		*searched = append(*searched, r.URL.Query().Get("search"))
		page := `{"servers":[
			{"server":{"name":"com.example/docs","title":"Example docs","description":"Search the docs.","version":"1.2.0","repository":{"url":"https://github.com/example/docs"},
				"remotes":[{"type":"streamable-http","url":"https://docs.example.com/mcp"},{"type":"sse","url":"https://docs.example.com/sse"},
				{"type":"streamable-http","url":"https://keyed.example.com/mcp","headers":[{"name":"X-Key","isRequired":true,"isSecret":true}]}]},
				"_meta":{"io.modelcontextprotocol.registry/official":{"status":"active"}}},
			{"server":{"name":"com.example-evil/docs","description":"Not in the namespace.","remotes":[{"type":"streamable-http","url":"https://evil.example/mcp"}]}},
			{"server":{"name":"com.example/old","description":"Gone.","remotes":[{"type":"streamable-http","url":"https://old.example.com/mcp"}]},
				"_meta":{"io.modelcontextprotocol.registry/official":{"status":"deprecated"}}}
		],"metadata":{"nextCursor":"2"}}`
		if r.URL.Query().Get("cursor") == "2" {
			page = `{"servers":[{"server":{"name":"com.example/plain","description":"Plain HTTP.","remotes":[{"type":"streamable-http","url":"http://plain.example.com/mcp"}]}},
				{"server":{"name":"com.example/maps","description":"Find places.","remotes":[{"type":"streamable-http","url":"https://maps.example.com/mcp"}]}}],"metadata":{}}`
		}
		fmt.Fprint(w, page)
	}))
}

func TestFetchRegistry(t *testing.T) {
	var searched []string
	server := registryServer(t, &searched)
	defer server.Close()
	list, err := fetchRegistry(context.Background(), server.Client(), Registry{URL: server.URL, Namespaces: []string{"com.example/*"}})
	if err != nil {
		t.Fatal(err)
	}
	var urls []string
	for _, l := range list {
		urls = append(urls, l.URL)
	}
	// Only active servers in the namespace, over https and Streamable HTTP.
	if want := []string{"https://docs.example.com/mcp", "https://keyed.example.com/mcp", "https://maps.example.com/mcp"}; !slices.Equal(urls, want) {
		t.Fatalf("listed %v, want %v", urls, want)
	}
	if !slices.Equal(searched, []string{"com.example/", "com.example/"}) {
		t.Fatalf("searched %v", searched)
	}
	if docs := list[0]; docs.Name != "com.example/docs" || docs.Version != "1.2.0" || docs.Repository != "https://github.com/example/docs" || docs.Source != server.URL || docs.needs() != "" {
		t.Fatalf("docs: %+v", docs)
	}
	if list[1].needs() != "X-Key" {
		t.Fatalf("keyed: %+v", list[1])
	}
}

func TestListingsAndEntries(t *testing.T) {
	var searched []string
	server := registryServer(t, &searched)
	defer server.Close()
	saved := &settings{}
	h := &Hub{Settings: saved, Transport: func() http.RoundTripper { return server.Client().Transport }}
	h.Configure(Servers{"mine": {URL: "https://docs.mcp.cloudflare.com/mcp"}})
	// Without namespaces the catalog is Mob's own list, less what is configured.
	for _, l := range h.Listings() {
		if l.Source != "mob" || l.URL == "https://docs.mcp.cloudflare.com/mcp" {
			t.Fatalf("listing: %+v", l)
		}
	}
	if len(searched) != 0 {
		t.Fatal("asked a registry without namespaces")
	}
	h.ConfigureRegistry(Registry{URL: server.URL, Namespaces: []string{"com.example/*"}})
	h.Listings()
	deadline := time.Now().Add(5 * time.Second)
	for len(h.Listings()) == len(curated)-1 {
		if time.Now().After(deadline) {
			t.Fatal("the registry's listings never arrived")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := len(h.Listings()); got != len(curated)-1+3 {
		t.Fatalf("%d listings", got)
	}
	entries := h.Entries()
	byURL := map[string]chat.Entry{}
	for _, e := range entries {
		if e.Kind != "MCP server" || !e.OwnerOnly {
			t.Fatalf("entry: %+v", e)
		}
		for _, l := range h.Listings() {
			if strings.Contains(e.Description, l.URL) {
				byURL[l.URL] = e
			}
		}
	}
	if e := byURL["https://maps.example.com/mcp"]; e.Name != "com.example/maps (maps.example.com)" || !strings.Contains(e.Use, `tool_install with url "https://maps.example.com/mcp"`) {
		t.Fatalf("maps entry: %+v", e)
	}
	if e := byURL["https://keyed.example.com/mcp"]; !strings.Contains(e.Use, "needs the X-Key header") {
		t.Fatalf("keyed entry: %+v", e)
	}
	// Other namespaces drop what the registry listed for these.
	h.ConfigureRegistry(Registry{URL: server.URL, Namespaces: []string{"org.other/*"}})
	if got := len(h.Listings()); got != len(curated)-1 {
		t.Fatalf("%d listings after changing namespaces", got)
	}
}

func TestRegistryValidate(t *testing.T) {
	for _, c := range []struct {
		registry Registry
		ok       bool
	}{
		{Registry{}, true},
		{Registry{URL: DefaultRegistry, Namespaces: []string{"com.cloudflare.mcp/*", "io.github.*/x"}}, true},
		{Registry{URL: "http://registry.example", Namespaces: []string{"a/*"}}, false},
		{Registry{URL: DefaultRegistry, Namespaces: []string{"no-slash"}}, false},
		{Registry{URL: DefaultRegistry, Namespaces: []string{"a/["}}, false},
	} {
		if err := c.registry.Validate(); (err == nil) != c.ok {
			t.Errorf("%+v: %v", c.registry, err)
		}
	}
}

func TestLocalName(t *testing.T) {
	servers := Servers{"cloudflare": {}}
	for raw, want := range map[string]string{
		"https://docs.mcp.cloudflare.com/mcp":                "cloudflare-docs",
		"https://mcp.cloudflare.com/mcp":                     "cloudflare-2",
		"https://gateway.pipeworx.io/cloudflare-radar/mcp":   "pipeworx-gateway-cloudflare",
		"https://mcp.com/mcp":                                "server",
		"https://a.very-long-host-name-for-testing.dev/tool": "very-long-host-name-for-test",
	} {
		got := localName(raw, servers)
		if got != want || len(got) > 32 || !serverName.MatchString(got) {
			t.Errorf("%s: %q, want %q", raw, got, want)
		}
	}
}

func TestInstall(t *testing.T) {
	settle = 50 * time.Millisecond
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	changes := 0
	h := &Hub{Settings: store, Changed: func() error { changes++; return nil }}
	h.Configure(Servers{"mine": {Command: "x"}})
	tool := h.InstallTool()
	if !tool.Available() || !tool.OwnerOnly || tool.Name != installName {
		t.Fatalf("tool: %+v", tool)
	}
	if _, err := tool.Run(context.Background(), chat.ToolCall{Input: map[string]any{"url": "https://unknown.example/mcp"}}); err == nil {
		t.Fatal("asked to install a server outside the catalog")
	}

	conversation, _ := store.Create()
	message, err := store.Begin(conversation.ID, chat.NewID(), "install", "test/model")
	if err != nil {
		t.Fatal(err)
	}
	var events []chat.Event
	part := chat.Part{}
	call := chat.ToolCall{ToolCall: llm.ToolCall{ID: "c1", Name: installName}, ConversationID: conversation.ID, Input: map[string]any{"url": curated[1].URL}, Part: part, Message: &message, Store: store, Send: func(e chat.Event) error { events = append(events, e); return nil }}
	if _, err := tool.Run(context.Background(), call); err != chat.ErrAwaitingApproval {
		t.Fatalf("run: %v", err)
	}
	request, _ := part["input"].(installRequest)
	if request.Server != "cloudflare-docs" || request.URL != curated[1].URL || request.Source != "mob" || len(events) != 1 {
		t.Fatalf("request: %+v, events %+v", request, events)
	}
	raw, _ := json.Marshal(request)
	out, err := tool.Approved(context.Background(), chat.ApprovedCall{ConversationID: conversation.ID, ApprovalID: "a1", Input: raw, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	if result := out.(map[string]string); result["installed"] != "cloudflare-docs" || !strings.Contains(result["status"], "tool_search") {
		t.Fatalf("result: %+v", result)
	}
	if changes != 1 || !h.Installed("cloudflare-docs") || !equalServers(Servers{"x": h.configured()["cloudflare-docs"]}, Servers{"x": {URL: curated[1].URL, OAuth: true}}) {
		t.Fatalf("after install: %d changes, servers %+v", changes, h.configured())
	}
	if slices.ContainsFunc(h.Listings(), func(l Listing) bool { return l.URL == curated[1].URL }) {
		t.Fatal("an installed server is still listed")
	}
	if _, err := tool.Approved(context.Background(), chat.ApprovedCall{ApprovalID: "a2", Input: raw, Store: store}); err == nil {
		t.Fatal("installed the same name twice")
	}
	if !strings.Contains(h.describe(), "cloudflare-docs (installed)") {
		t.Fatalf("describe: %s", h.describe())
	}

	// A reload keeps it; config.yaml wins a name it takes later.
	again := &Hub{Settings: store}
	again.Configure(Servers{"mine": {Command: "x"}})
	if again.configured()["cloudflare-docs"].URL != curated[1].URL {
		t.Fatalf("after reload: %+v", again.configured())
	}
	again.Configure(Servers{"cloudflare-docs": {Command: "y"}})
	if again.configured()["cloudflare-docs"].Command != "y" || again.Installed("cloudflare-docs") {
		t.Fatalf("config.yaml lost a name: %+v", again.configured())
	}

	if err := h.Remove("mine"); err == nil {
		t.Fatal("removed a configured server")
	}
	if err := h.Remove("cloudflare-docs"); err != nil {
		t.Fatal(err)
	}
	if changes != 2 || h.Installed("cloudflare-docs") || len(h.configured()) != 1 {
		t.Fatalf("after remove: %d changes, %+v", changes, h.configured())
	}
}
