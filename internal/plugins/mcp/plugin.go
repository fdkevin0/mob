package mcp

import (
	"context"
	"fmt"
	"strings"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/extension"
)

// Extension keeps Mob connected to the configured servers.
func Extension(h *Hub) extension.Extension {
	return extension.Extension{Name: "mcp", Start: func() (extension.Serve, error) {
		servers := h.configured()
		if len(servers) == 0 {
			return nil, nil
		}
		return func(ctx context.Context, status func(string)) { h.serve(ctx, servers, status) }, nil
	}}
}

// Commands show the servers and their tools.
func Commands(h *Hub) []chat.Command {
	return []chat.Command{{
		CommandSpec: chat.CommandSpec{Name: "mcp", Usage: "/mcp", Summary: "Show MCP servers and their tools", Clients: chat.Interactive},
		OwnerOnly:   true,
		Run:         func(context.Context, chat.CommandCall) (chat.CommandResult, error) { return chat.Reply(h.describe()) },
	}}
}

// describe is a table of the servers and the tools they offer.
func (h *Hub) describe() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.servers) == 0 {
		return "No MCP servers are configured. Add them under `mcp_servers` in config.yaml."
	}
	var b strings.Builder
	b.WriteString("| Server | Status | Tools |\n| --- | --- | --- |\n")
	for _, name := range h.servers.names() {
		status, tools := "not running", []string{}
		if s := h.states[name]; s != nil {
			status = s.status
			if s.session == nil && len(s.tools) > 0 {
				status += " (tools unavailable until it reconnects)"
			}
			for _, t := range s.tools {
				tools = append(tools, "`"+toolName(name, t.Name)+"`")
			}
		}
		fmt.Fprintf(&b, "| %s | %s | %s |\n", chat.Cell(name), chat.Cell(status), strings.Join(tools, " "))
	}
	b.WriteString("\nEach call waits for your approval; **Always allow** stops asking for that tool on that server.")
	return b.String()
}
