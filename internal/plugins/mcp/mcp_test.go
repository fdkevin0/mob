package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/fdkevin0/mob/internal/chat"
)

// TestMain lets the test binary serve as the MCP server the tests start.
func TestMain(m *testing.M) {
	if os.Getenv("MCP_TEST_SERVER") == "1" {
		if os.Getenv("MOB_SECRET") != "" {
			os.Exit(3)
		}
		testServer().Run(context.Background(), &sdk.StdioTransport{})
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type shoutInput struct {
	Text string `json:"text"`
}

func testServer() *sdk.Server {
	server := sdk.NewServer(&sdk.Implementation{Name: "test"}, nil)
	sdk.AddTool(server, &sdk.Tool{Name: "shout", Description: "Upper-case text."}, func(_ context.Context, _ *sdk.CallToolRequest, in shoutInput) (*sdk.CallToolResult, any, error) {
		if in.Text == "" {
			return &sdk.CallToolResult{IsError: true, Content: []sdk.Content{&sdk.TextContent{Text: "nothing to shout"}}}, nil, nil
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: strings.ToUpper(in.Text)}}}, nil, nil
	})
	return server
}

// running serves h until the test ends and waits for server to connect.
func running(t *testing.T, h *Hub, server string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	serve, err := Extension(h).Start()
	if err != nil || serve == nil {
		t.Fatalf("start: %v", err)
	}
	done := make(chan struct{})
	go func() { defer close(done); serve(ctx, func(string) {}) }()
	t.Cleanup(func() { cancel(); <-done })
	for deadline := time.Now().Add(20 * time.Second); !h.connected(server); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not connect: %s", server, h.Status())
		}
	}
}

func approve(t *testing.T, h *Hub, name string, r request) (any, error) {
	t.Helper()
	for _, tool := range h.Tools() {
		if tool.Name == name {
			raw, _ := json.Marshal(r)
			return tool.Approved(context.Background(), chat.ApprovedCall{Input: raw})
		}
	}
	t.Fatalf("no tool %s in %+v", name, h.Tools())
	return nil, nil
}

func TestCommandServerTools(t *testing.T) {
	t.Setenv("MOB_SECRET", "token")
	server := Server{Command: os.Args[0], Env: []string{"MCP_TEST_SERVER=1"}}
	h := &Hub{}
	h.Configure(Servers{"echo": server})
	running(t, h, "echo")

	tools := h.Tools()
	if len(tools) != 1 || tools[0].Name != "mcp__echo__shout" || !tools[0].OwnerOnly || tools[0].Parameters["type"] != "object" || !tools[0].Available() {
		t.Fatalf("tools: %+v", tools)
	}
	if !strings.Contains(tools[0].Description, "Upper-case text.") {
		t.Fatalf("description: %s", tools[0].Description)
	}
	call := request{Server: "echo", Tool: "shout", Arguments: map[string]any{"text": "hi"}, Target: server.target()}
	if out, err := approve(t, h, "mcp__echo__shout", call); err != nil || out != "HI" {
		t.Fatalf("call: %v %v", out, err)
	}
	empty := call
	empty.Arguments = map[string]any{"text": ""}
	if _, err := approve(t, h, "mcp__echo__shout", empty); err == nil || err.Error() != "nothing to shout" {
		t.Fatalf("tool error: %v", err)
	}
	moved := call
	moved.Target = "something else"
	if _, err := approve(t, h, "mcp__echo__shout", moved); err == nil || !strings.Contains(err.Error(), "reconfigured") {
		t.Fatalf("a call approved for another target ran: %v", err)
	}
	if scope := tools[0].Scope(json.RawMessage(`{"target":"x"}`)); scope != "x" {
		t.Fatalf("scope: %q", scope)
	}
	if !strings.Contains(h.describe(), "`mcp__echo__shout`") || h.Status() != "echo: 1 tools" {
		t.Fatalf("describe: %s; status: %s", h.describe(), h.Status())
	}
}

func TestURLServerGetsHeaders(t *testing.T) {
	handler := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return testServer() }, nil)
	authorized := false
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		authorized = true
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(httpServer.Close)
	server := Server{URL: httpServer.URL, Headers: map[string]string{"authorization": "Bearer secret"}}
	h := &Hub{}
	h.Configure(Servers{"web": server})
	running(t, h, "web")
	out, err := approve(t, h, "mcp__web__shout", request{Server: "web", Tool: "shout", Arguments: map[string]any{"text": "ok"}, Target: server.target()})
	if err != nil || out != "OK" || !authorized {
		t.Fatalf("call: %v %v", out, err)
	}
}

func TestDisconnectedAndRemovedServers(t *testing.T) {
	h := &Hub{}
	if serve, err := Extension(h).Start(); serve != nil || err != nil {
		t.Fatal("ran with no servers")
	}
	h.Configure(Servers{"gone": {Command: "mob-no-such-command"}})
	if _, err := h.call(context.Background(), request{Server: "gone", Target: "mob-no-such-command"}); err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("disconnected: %v", err)
	}
	h.Configure(Servers{})
	if _, err := h.call(context.Background(), request{Server: "gone", Target: "mob-no-such-command"}); !errors.Is(err, errUnknown) {
		t.Fatalf("removed: %v", err)
	}
}

func TestValidate(t *testing.T) {
	for _, c := range []struct {
		servers Servers
		ok      bool
	}{
		{Servers{"github": {Command: "npx", Args: []string{"-y", "server"}, Env: []string{"TOKEN=x"}}}, true},
		{Servers{"docs": {URL: "https://example.com/mcp", Headers: map[string]string{"authorization": "Bearer x"}}}, true},
		{Servers{"both": {Command: "x", URL: "https://example.com"}}, false},
		{Servers{"none": {}}, false},
		{Servers{"a__b": {Command: "x"}}, false},
		{Servers{"Bad Name": {Command: "x"}}, false},
		{Servers{"ftp": {URL: "ftp://example.com"}}, false},
		{Servers{"env": {Command: "x", Env: []string{"NOVALUE"}}}, false},
		{Servers{"mixed": {URL: "https://example.com", Args: []string{"x"}}}, false},
		{Servers{"mixed": {Command: "x", Headers: map[string]string{"a": "b"}}}, false},
	} {
		if err := c.servers.Validate(); (err == nil) != c.ok {
			t.Errorf("%+v: %v", c.servers, err)
		}
	}
}

func TestToolName(t *testing.T) {
	if got := toolName("fs", "read.file"); got != "mcp__fs__read_file" {
		t.Fatalf("got %s", got)
	}
	long := toolName("server", strings.Repeat("x", 80))
	if len(long) != 64 || long == toolName("server", strings.Repeat("x", 81)) {
		t.Fatalf("long names: %s", long)
	}
}
