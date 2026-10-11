package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

// toolOutput bounds the result the model reads, in bytes.
const toolOutput = 32 << 10

// request is a call of an MCP tool, as the user approves it.
type request struct {
	Server    string         `json:"server"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments,omitempty"`
	// Target shows the user the server's command line or URL.
	Target string `json:"target"`
	// Config is the server configuration's fingerprint when the user was
	// asked; an approved call runs only while it is unchanged.
	Config string `json:"config"`
}

// unsafe is what models do not accept in a tool name.
var unsafe = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// toolName is mcp__<server>__<tool> when that uses only the characters
// models accept and is at most 64 long. Otherwise it is cut to fit, with
// those characters replaced, and ends in a hash of the real name, so that
// read.file and read_file stay apart.
func toolName(server, tool string) string {
	name := "mcp__" + server + "__" + tool
	safe := unsafe.ReplaceAllString(name, "_")
	if safe == name && len(name) <= 64 {
		return name
	}
	sum := sha256.Sum256([]byte(name))
	return safe[:min(len(safe), 47)] + "_" + hex.EncodeToString(sum[:8])
}

// Tools are the tools of every server Mob has connected to. A tool is offered
// to the owner's turns while its server is connected, and every call waits
// for the owner's approval unless they chose to always allow it.
func (h *Hub) Tools() []chat.Tool {
	h.mu.Lock()
	defer h.mu.Unlock()
	var list []chat.Tool
	for _, name := range h.servers.names() {
		s := h.states[name]
		if s == nil {
			continue
		}
		for _, tool := range s.tools {
			list = append(list, h.tool(name, s.server, tool))
		}
	}
	return list
}

func (h *Hub) tool(server string, config Server, tool *sdk.Tool) chat.Tool {
	description := strings.TrimSpace(tool.Description)
	if description == "" {
		description = tool.Title
	}
	if len(description) > 2000 {
		description = description[:2000] + "…"
	}
	return chat.Tool{
		Tool: llm.Tool{
			Name:        toolName(server, tool.Name),
			Description: "Tool " + tool.Name + " of the MCP server " + server + ", which the user configured; each call waits for the user's approval. " + description,
			Parameters:  parameters(tool.InputSchema),
		},
		OwnerOnly: true,
		Available: func() bool { return h.connected(server) },
		Run: func(_ context.Context, call chat.ToolCall) (any, error) {
			return nil, call.RequestApproval(request{Server: server, Tool: tool.Name, Arguments: call.Input, Target: config.target(), Config: config.fingerprint()})
		},
		Approved: func(ctx context.Context, call chat.ApprovedCall) (any, error) {
			var r request
			if err := json.Unmarshal(call.Input, &r); err != nil {
				return nil, err
			}
			return h.call(ctx, r)
		},
		// Always allowing a tool covers that tool only, on the server as it
		// was configured when it was allowed.
		Scope: func(input json.RawMessage) string {
			var r request
			json.Unmarshal(input, &r)
			return strconv.Quote(r.Tool) + " on " + r.Server + " (" + r.Target + ", configuration " + r.Config + ")"
		},
	}
}

// parameters is a tool's input schema as models take it: a JSON object
// schema, or one that accepts any object.
func parameters(schema any) map[string]any {
	var object map[string]any
	if raw, err := json.Marshal(schema); err == nil {
		json.Unmarshal(raw, &object)
	}
	if object == nil || object["type"] != "object" {
		return map[string]any{"type": "object"}
	}
	return object
}

func (h *Hub) connected(server string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.states[server]
	return s != nil && s.session != nil
}

// call runs an approved call on the server it was approved for.
func (h *Hub) call(ctx context.Context, r request) (any, error) {
	h.mu.Lock()
	config, configured := h.servers[r.Server]
	s := h.states[r.Server]
	var session *sdk.ClientSession
	if s != nil {
		session = s.session
	}
	h.mu.Unlock()
	switch {
	case !configured:
		return nil, errUnknown
	case config.fingerprint() != r.Config:
		return nil, errors.New("the MCP server " + r.Server + " was reconfigured after this call was approved; ask again")
	case session == nil:
		return nil, errors.New("the MCP server " + r.Server + " is not connected")
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: r.Tool, Arguments: r.Arguments})
	if err != nil {
		return nil, err
	}
	output := render(result)
	if result.IsError {
		return nil, errors.New(output)
	}
	return output, nil
}

// render is what the model reads of a result: its text, other content as
// JSON, and its structured content when it has no text.
func render(result *sdk.CallToolResult) string {
	var parts []string
	for _, content := range result.Content {
		if text, ok := content.(*sdk.TextContent); ok {
			parts = append(parts, text.Text)
			continue
		}
		raw, _ := json.Marshal(content)
		parts = append(parts, string(raw))
	}
	if len(parts) == 0 && result.StructuredContent != nil {
		raw, _ := json.Marshal(result.StructuredContent)
		parts = append(parts, string(raw))
	}
	output := strings.Join(parts, "\n")
	if len(output) > toolOutput {
		output = output[:toolOutput] + "\n[truncated]"
	}
	return output
}
