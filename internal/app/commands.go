package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
)

// pluginCommands are the commands about plugins in general; each plugin adds
// its own.
func (s *Server) pluginCommands() []chat.Command {
	spec := func(name, usage, summary string) chat.CommandSpec {
		return chat.CommandSpec{Name: name, Usage: usage, Summary: summary, Clients: chat.Interactive}
	}
	var names []string
	for _, section := range configuration.Sections() {
		names = append(names, section.Name)
	}
	plugins := chat.Choices(names...)
	return []chat.Command{
		{CommandSpec: spec("plugins", "/plugins", "Configure plugins and cloud services"), Run: action(chat.OpenPlugins)},
		{CommandSpec: spec("test", "/test PLUGIN", "Test a plugin connection"), OwnerOnly: true, Args: []chat.Argument{plugins}, Run: s.testCommand},
		{CommandSpec: spec("deliveries", "/deliveries", "Show channel delivery status"), Run: s.deliveriesCommand},
		{CommandSpec: spec("clear-secret", "/clear-secret PLUGIN FIELD", "Clear a saved credential of a disabled plugin"), OwnerOnly: true, Args: []chat.Argument{plugins, secretChoices}, Run: s.clearSecretCommand},
	}
}

func action(kind string) func(context.Context, chat.CommandCall) (chat.CommandResult, error) {
	return func(context.Context, chat.CommandCall) (chat.CommandResult, error) {
		return chat.CommandResult{Action: &chat.Action{Kind: kind}}, nil
	}
}

func secretChoices(ctx context.Context, call chat.CommandCall, prior []string) []chat.Suggestion {
	section, _ := configuration.Lookup(prior[0])
	return chat.Choices(section.Secrets...)(ctx, call, prior)
}

func (s *Server) testCommand(ctx context.Context, call chat.CommandCall) (chat.CommandResult, error) {
	if len(call.Fields) != 1 {
		return chat.Reply("Use `/test email|telegram|cloudflare|wechat_ilink`.")
	}
	name := call.Fields[0]
	result, err := s.testPlugin(ctx, name)
	var command *chat.CommandError
	if errors.As(err, &command) {
		return chat.Reply(command.Message + ".")
	}
	if err != nil {
		return chat.Reply("**" + chat.Cell(name) + "** connection failed: " + err.Error())
	}
	return chat.ReplyJSON("**"+chat.Cell(name)+"** connection works.", result)
}

func (s *Server) deliveriesCommand(context.Context, chat.CommandCall) (chat.CommandResult, error) {
	rows, err := s.Store.Deliveries()
	if err != nil {
		return chat.CommandResult{}, err
	}
	if len(rows) == 0 {
		return chat.Reply("No deliveries yet.")
	}
	var b strings.Builder
	b.WriteString("| Delivery | State | Updated | Error |\n| --- | --- | --- | --- |\n")
	for _, d := range rows {
		updated := "unknown"
		if d.UpdatedAt > 0 {
			updated = time.UnixMilli(d.UpdatedAt).Format(time.DateTime)
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s |\n", d.ID, chat.Cell(d.State), updated, chat.Cell(d.Error))
	}
	b.WriteString("\nUncertain or interrupted sends are never retried automatically.")
	return chat.Reply(b.String())
}

func (s *Server) clearSecretCommand(_ context.Context, call chat.CommandCall) (chat.CommandResult, error) {
	const help = "Use `/clear-secret PLUGIN FIELD` after disabling the plugin, e.g. `/clear-secret email imap.password`."
	if len(call.Fields) != 2 {
		return chat.Reply(help)
	}
	name, field := call.Fields[0], call.Fields[1]
	if _, ok := configuration.Lookup(name); !ok {
		return chat.Reply(help)
	}
	c, err := s.pluginConfig()
	if err != nil {
		return chat.CommandResult{}, err
	}
	// Resubmit the saved public configuration with only the credential cleared.
	var sections map[string]map[string]any
	raw, _ := json.Marshal(c.Public())
	if err := json.Unmarshal(raw, &sections); err != nil {
		return chat.CommandResult{}, err
	}
	body := sections[name]
	body["secrets"] = map[string]configuration.SecretUpdate{field: {Mode: "clear"}}
	raw, _ = json.Marshal(body)
	if _, err := s.updatePlugin(name, raw); err != nil {
		var command *chat.CommandError
		if errors.As(err, &command) {
			return chat.CommandResult{}, err
		}
		return chat.Reply("Cannot clear " + chat.Cell(field) + ": " + err.Error())
	}
	return chat.Reply("Cleared the saved " + chat.Cell(field) + " of " + name + ".")
}

// runCommand answers POST /api/commands/run.
func (s *Server) runCommand(w http.ResponseWriter, r *http.Request) {
	var input chat.CommandRequest
	if !decodeRequest(w, r, &input) {
		return
	}
	// Holders of the local token run this Mob.
	result, err := s.Commands.Run(r.Context(), input, true)
	var command *chat.CommandError
	if errors.As(err, &command) {
		http.Error(w, command.Message, command.Status)
		return
	}
	pluginResult(w, result, err)
}
