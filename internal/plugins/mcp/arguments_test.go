package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestEmptyArgumentsAreAnObject(t *testing.T) {
	remote := sdk.NewServer(&sdk.Implementation{Name: "arguments"}, nil)
	remote.AddTool(&sdk.Tool{Name: "empty", InputSchema: map[string]any{"type": "object"}}, func(_ context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(req.Params.Arguments)}}}, nil
	})
	httpServer := httptest.NewServer(sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return remote }, nil))
	t.Cleanup(httpServer.Close)
	server := Server{URL: httpServer.URL}
	h := &Hub{}
	h.Configure(Servers{"args": server})
	running(t, h, "args")
	out, err := h.call(context.Background(), request{Server: "args", Tool: "empty", Config: server.fingerprint()})
	if err != nil || out != "{}" {
		t.Fatalf("empty tool arguments: %v, %v", out, err)
	}
}
