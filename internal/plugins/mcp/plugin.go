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
		CommandSpec: chat.CommandSpec{Name: "mcp", Usage: "/mcp [remove NAME]", Summary: "Show MCP servers and their tools, or remove an installed one", Clients: chat.Interactive},
		OwnerOnly:   true,
		Run: func(_ context.Context, call chat.CommandCall) (chat.CommandResult, error) {
			switch {
			case len(call.Fields) == 0:
				return chat.Reply(h.describe())
			case len(call.Fields) == 2 && call.Fields[0] == "remove":
				if err := h.Remove(call.Fields[1]); err != nil {
					return chat.CommandResult{}, &chat.CommandError{Status: 400, Message: err.Error()}
				}
				return chat.Reply("Removed " + call.Fields[1] + " and its sign-in.")
			}
			return chat.CommandResult{}, &chat.CommandError{Status: 400, Message: "usage: /mcp [remove NAME]"}
		},
	}}
}

// describe is a table of the servers and the tools they offer.
func (h *Hub) describe() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.servers) == 0 {
		return "No MCP servers are configured. Add them under `mcp_servers` in config.yaml, or let the model install one with tool_install."
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
				tool := "`" + toolName(name, t.Name) + "`"
				if e := h.servers[name].exposure(t.Name); e != chat.Deferred {
					tool += " (" + e.String() + ")"
				}
				tools = append(tools, tool)
			}
		}
		label := name
		if _, configured := h.config[name]; !configured {
			label += " (installed)"
		}
		fmt.Fprintf(&b, "| %s | %s | %s |\n", chat.Cell(label), chat.Cell(status), strings.Join(tools, " "))
	}
	b.WriteString("\nThe model loads a server's tools with tool_search when a task needs them, unless `exposure` says otherwise. Each call waits for your approval; **Always allow** stops asking for that tool on that server.")
	return b.String()
}
