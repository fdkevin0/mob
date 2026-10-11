package email

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/extension"
	"github.com/fdkevin0/mob/internal/llm"
)

// Host is what the email plugin uses from Mob.
type Host struct {
	// Config reads the saved configuration.
	Config func() (Config, error)
	Store  *chat.Store
	// Model is the default model, which analyzes mail.
	Model func() (llm.Model, error)
}

// analyzeTimeout bounds reading and summarizing one message.
const analyzeTimeout = 45 * time.Second

// enabled is the configuration, or a 409 *chat.CommandError while the plugin
// is disabled.
func (h Host) enabled() (Config, error) {
	c, err := h.Config()
	if err == nil && !c.Enabled {
		err = &chat.CommandError{Status: 409, Message: "email plugin is disabled"}
	}
	return c, err
}

func (h Host) service(c Config) *Service { return &Service{Config: c, Store: h.Store, Model: h.Model} }

// Commands are /mail, which opens the composer, and /email.
func Commands(h Host) []chat.Command {
	spec := func(name, usage, summary string) chat.CommandSpec {
		return chat.CommandSpec{Name: name, Usage: usage, Summary: summary, Clients: chat.Interactive}
	}
	return []chat.Command{
		{CommandSpec: spec("mail", "/mail", "Compose an email"), OwnerOnly: true, Run: func(context.Context, chat.CommandCall) (chat.CommandResult, error) {
			return chat.CommandResult{Action: &chat.Action{Kind: chat.ComposeMail}}, nil
		}},
		{CommandSpec: spec("email", "/email [UID VALIDITY | analyze UID VALIDITY]", "List, read or summarize INBOX mail"), OwnerOnly: true, Args: []chat.Argument{chat.Choices("analyze")}, Run: h.command},
	}
}

func (h Host) command(ctx context.Context, call chat.CommandCall) (chat.CommandResult, error) {
	const help = "`/email` lists INBOX · `/email UID VALIDITY` reads · `/email analyze UID VALIDITY` summarizes with your model."
	c, err := h.enabled()
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
			return chat.Reply("INBOX is empty.")
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
		return chat.Reply(b.String() + "\n" + help)
	case len(f) == 2:
		uid, validity, ok := identity(f[0], f[1])
		if !ok {
			return chat.Reply(help)
		}
		mail, err := c.Read(ctx, uid, validity)
		if err != nil {
			return chat.CommandResult{}, err
		}
		text := fmt.Sprintf("**%s**\n\nFrom %s · %s\n\n%s", chat.Cell(mail.Subject), chat.Cell(mail.From), chat.Cell(mail.Date), chat.Fence("", mail.Text))
		if len(mail.Attachments) > 0 {
			text += "\n\nAttachments: " + chat.Cell(strings.Join(mail.Attachments, ", "))
		}
		return chat.Reply(text + fmt.Sprintf("\n\nSummarize with `/email analyze %d %d`.", uid, validity))
	case len(f) == 3 && f[0] == "analyze":
		uid, validity, ok := identity(f[1], f[2])
		if !ok {
			return chat.Reply(help)
		}
		ctx, cancel := context.WithTimeout(ctx, analyzeTimeout)
		defer cancel()
		verdict, err := h.service(c).Analyze(ctx, uid, validity)
		if err != nil {
			return chat.CommandResult{}, err
		}
		return chat.Reply(fmt.Sprintf("**%s** · %s\n\n%s", chat.Cell(verdict.Level), chat.Cell(verdict.Category), verdict.Summary))
	}
	return chat.Reply(help)
}

// Routes serve the web UI's mailbox: listing and reading INBOX, sending and
// analyzing mail.
func Routes(h Host) []extension.Route {
	return []extension.Route{
		{Method: "GET", Path: "inbox", Handle: func(r *http.Request) (any, error) {
			c, err := h.enabled()
			if err != nil {
				return nil, err
			}
			return c.Inbox(r.Context())
		}},
		{Method: "GET", Path: "messages/{uid}", Handle: func(r *http.Request) (any, error) {
			c, err := h.enabled()
			if err != nil {
				return nil, err
			}
			uid, e1 := strconv.ParseUint(r.PathValue("uid"), 10, 32)
			validity, e2 := strconv.ParseUint(r.URL.Query().Get("validity"), 10, 32)
			if e1 != nil || e2 != nil || uid == 0 || validity == 0 {
				return nil, &chat.CommandError{Status: 400, Message: "invalid message identity"}
			}
			return c.Read(r.Context(), uint32(uid), uint32(validity))
		}},
		{Method: "POST", Path: "send", Handle: func(r *http.Request) (any, error) {
			c, err := h.enabled()
			if err != nil {
				return nil, err
			}
			var input struct {
				Draft
				RequestID string `json:"requestId"`
			}
			if err := extension.Decode(r, &input); err != nil {
				return nil, err
			}
			if err := h.service(c).Send(r.Context(), input.RequestID, input.Draft); err != nil {
				return nil, err
			}
			return map[string]bool{"sent": true}, nil
		}},
		{Method: "POST", Path: "analyze", Handle: func(r *http.Request) (any, error) {
			c, err := h.enabled()
			if err != nil {
				return nil, err
			}
			var input struct {
				UID      uint32 `json:"uid"`
				Validity uint32 `json:"validity"`
			}
			if err := extension.Decode(r, &input); err != nil {
				return nil, err
			}
			if input.UID == 0 || input.Validity == 0 {
				return nil, &chat.CommandError{Status: 400, Message: "invalid message identity"}
			}
			ctx, cancel := context.WithTimeout(r.Context(), analyzeTimeout)
			defer cancel()
			return h.service(c).Analyze(ctx, input.UID, input.Validity)
		}},
	}
}
