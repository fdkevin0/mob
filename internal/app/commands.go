package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/plugins/cloudflare"
	"github.com/fdkevin0/mob/internal/plugins/email"
)

var interactive = []string{chat.ClientWeb, chat.ClientTUI}

// secretFields are the credentials each plugin can clear.
var secretFields = map[string][]string{
	"email":        {"imap.password", "smtp.password"},
	"telegram":     {"token"},
	"cloudflare":   {"token", "secretKey"},
	"wechat_ilink": {"botToken"},
}

var cloudOperations = []string{"ai.models", "ai.run", "vectorize.indexes", "vectorize.query", "d1.databases", "d1.query", "kv.namespaces", "kv.get", "r2.buckets", "r2.list", "r2.get"}

// pluginCommands are the commands about plugins and cloud services.
func (s *Server) pluginCommands() []chat.Command {
	spec := func(name, usage, summary string) chat.CommandSpec {
		return chat.CommandSpec{Name: name, Usage: usage, Summary: summary, Clients: interactive}
	}
	plugins := chat.Choices("email", "telegram", "cloudflare", "wechat_ilink")
	return []chat.Command{
		{CommandSpec: spec("plugins", "/plugins", "Configure plugins and cloud services"), Run: action(chat.OpenPlugins)},
		{CommandSpec: spec("mail", "/mail", "Compose an email"), OwnerOnly: true, Run: action(chat.ComposeMail)},
		{CommandSpec: spec("email", "/email [UID VALIDITY | analyze UID VALIDITY]", "List, read or summarize INBOX mail"), OwnerOnly: true, Args: []chat.Argument{chat.Choices("analyze")}, Run: s.emailCommand},
		{CommandSpec: spec("cloud", "/cloud OPERATION [ARGUMENT]", "Run a Cloudflare operation; D1 runs writes too and Workers AI may incur charges"), OwnerOnly: true, Args: []chat.Argument{chat.Choices(cloudOperations...)}, Run: s.cloudCommand},
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
	return chat.Choices(secretFields[prior[0]]...)(ctx, call, prior)
}

func usage(text string) (chat.CommandResult, error) { return chat.CommandResult{Markdown: text}, nil }

func jsonResult(title string, value any) (chat.CommandResult, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return chat.CommandResult{}, err
	}
	return chat.CommandResult{Markdown: title + "\n\n" + chat.Fence("json", string(raw))}, nil
}

func (s *Server) emailCommand(ctx context.Context, call chat.CommandCall) (chat.CommandResult, error) {
	const help = "`/email` lists INBOX · `/email UID VALIDITY` reads · `/email analyze UID VALIDITY` summarizes with your model."
	c, err := s.enabledEmail()
	if err != nil {
		return chat.CommandResult{}, err
	}
	identity := func(uid, validity string) (uint32, uint32, bool) {
		u, e1 := strconv.ParseUint(uid, 10, 32)
		v, e2 := strconv.ParseUint(validity, 10, 32)
		return uint32(u), uint32(v), e1 == nil && e2 == nil && u != 0 && v != 0
	}
	f := call.Fields
	switch {
	case len(f) == 0:
		inbox, err := c.Inbox(ctx)
		if err != nil {
			return chat.CommandResult{}, err
		}
		if len(inbox) == 0 {
			return usage("INBOX is empty.")
		}
		var b strings.Builder
		b.WriteString("| From | Subject | Date | Read with |\n| --- | --- | --- | --- |\n")
		for _, m := range inbox {
			subject := m.Subject
			if subject == "" {
				subject = "(no subject)"
			}
			fmt.Fprintf(&b, "| %s | %s | %s | `/email %d %d` |\n", chat.Cell(m.From), chat.Cell(subject), chat.Cell(m.Date), m.UID, m.Validity)
		}
		return usage(b.String() + "\n" + help)
	case len(f) == 2:
		uid, validity, ok := identity(f[0], f[1])
		if !ok {
			return usage(help)
		}
		mail, err := c.Read(ctx, uid, validity)
		if err != nil {
			return chat.CommandResult{}, err
		}
		text := fmt.Sprintf("**%s**\n\nFrom %s · %s\n\n%s", chat.Cell(mail.Subject), chat.Cell(mail.From), chat.Cell(mail.Date), chat.Fence("", mail.Text))
		if len(mail.Attachments) > 0 {
			text += "\n\nAttachments: " + chat.Cell(strings.Join(mail.Attachments, ", "))
		}
		return usage(text + fmt.Sprintf("\n\nSummarize with `/email analyze %d %d`.", uid, validity))
	case len(f) == 3 && f[0] == "analyze":
		uid, validity, ok := identity(f[1], f[2])
		if !ok {
			return usage(help)
		}
		ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		verdict, err := (&email.Service{Config: c, Store: s.Store, Model: s.defaultModel}).Analyze(ctx, uid, validity)
		if err != nil {
			return chat.CommandResult{}, err
		}
		return usage(fmt.Sprintf("**%s** · %s\n\n%s", chat.Cell(verdict.Level), chat.Cell(verdict.Category), verdict.Summary))
	}
	return usage(help)
}

func (s *Server) cloudCommand(ctx context.Context, call chat.CommandCall) (chat.CommandResult, error) {
	if len(call.Fields) == 0 {
		return usage("`/cloud " + strings.Join(cloudOperations, "|") + " [prompt/search/key/SQL]`\n\nD1 executes your SQL, including writes. Workers AI calls may incur charges.")
	}
	operation := call.Fields[0]
	argument := strings.TrimSpace(strings.TrimPrefix(call.Rest, operation))
	c, err := s.pluginConfig()
	if err != nil {
		return chat.CommandResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	result, err := c.Cloudflare.Do(ctx, cloudflare.Action{Operation: operation, Text: argument, Key: argument, SQL: argument})
	if err != nil {
		return chat.CommandResult{}, err
	}
	return jsonResult("**"+chat.Cell(operation)+"**", result)
}

func (s *Server) testCommand(ctx context.Context, call chat.CommandCall) (chat.CommandResult, error) {
	if len(call.Fields) != 1 {
		return usage("Use `/test email|telegram|cloudflare|wechat_ilink`.")
	}
	name := call.Fields[0]
	result, err := s.testPlugin(ctx, name)
	var command *chat.CommandError
	if errors.As(err, &command) {
		return usage(command.Message + ".")
	}
	if err != nil {
		return usage("**" + chat.Cell(name) + "** connection failed: " + err.Error())
	}
	return jsonResult("**"+chat.Cell(name)+"** connection works.", result)
}

func (s *Server) deliveriesCommand(context.Context, chat.CommandCall) (chat.CommandResult, error) {
	rows, err := s.Store.Deliveries()
	if err != nil {
		return chat.CommandResult{}, err
	}
	if len(rows) == 0 {
		return usage("No deliveries yet.")
	}
	var b strings.Builder
	b.WriteString("| Delivery | State | Updated | Error |\n| --- | --- | --- | --- |\n")
	for _, d := range rows {
		updated := "before migration"
		if d.UpdatedAt > 0 {
			updated = time.UnixMilli(d.UpdatedAt).Format(time.DateTime)
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s | %s |\n", d.ID, chat.Cell(d.State), updated, chat.Cell(d.Error))
	}
	b.WriteString("\nUncertain or interrupted sends are never retried automatically.")
	return usage(b.String())
}

func (s *Server) clearSecretCommand(_ context.Context, call chat.CommandCall) (chat.CommandResult, error) {
	const help = "Use `/clear-secret PLUGIN FIELD` after disabling the plugin, e.g. `/clear-secret email imap.password`."
	if len(call.Fields) != 2 {
		return usage(help)
	}
	name, field := call.Fields[0], call.Fields[1]
	if _, ok := secretFields[name]; !ok {
		return usage(help)
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
		return usage("Cannot clear " + chat.Cell(field) + ": " + err.Error())
	}
	return usage("Cleared the saved " + chat.Cell(field) + " of " + name + ".")
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
