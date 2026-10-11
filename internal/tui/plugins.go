package tui

import (
	"encoding/json"
	"fmt"
	configcontract "github.com/fdkevin0/mob/internal/configuration"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
)

type pluginField struct{ path, label, kind string }
type pluginForm struct {
	name      string
	config    map[string]map[string]any
	fields    []pluginField
	index     int
	input     textinput.Model
	saving    bool
	requestID string
}
type pluginsLoaded struct {
	Config map[string]map[string]any `json:"config"`
	Err    error
}
type pluginSaved struct{ Err error }

func (m model) loadPlugins() tea.Cmd {
	return func() tea.Msg { var v pluginsLoaded; v.Err = m.json("GET", "/api/plugins", nil, &v); return v }
}
func newPluginForm() *pluginForm {
	input := textinput.New()
	input.CharLimit = 4096
	input.Focus()
	return &pluginForm{input: input, index: -1}
}
func fieldsFor(name string) []pluginField {
	switch name {
	case "email":
		return []pluginField{
			{"enabled", "Enable email (true/false)", "bool"}, {"from", "From address", "text"},
			{"imap.host", "IMAP host", "text"}, {"imap.port", "IMAP port (993 TLS / 143 STARTTLS)", "int"}, {"imap.security", "IMAP security (tls/starttls)", "text"}, {"imap.username", "IMAP username", "text"}, {"imap.password", "IMAP password (blank keeps existing for same host/user)", "secret"},
			{"smtp.host", "SMTP host", "text"}, {"smtp.port", "SMTP port (465 TLS / 587 STARTTLS)", "int"}, {"smtp.security", "SMTP security (tls/starttls)", "text"}, {"smtp.username", "SMTP username", "text"}, {"smtp.password", "SMTP password (blank keeps existing for same host/user)", "secret"}}
	case "telegram":
		return []pluginField{{"enabled", "Enable Telegram (true/false)", "bool"}, {"token", "Bot Token (blank keeps saved token)", "secret"}, {"userId", "Allowed Telegram user ID (private messages only)", "int"}}
	case "cloudflare":
		return []pluginField{{"enabled", "Enable Cloudflare (true/false)", "bool"}, {"accountId", "Cloudflare account ID", "text"}, {"token", "API Token (blank keeps existing for same account)", "secret"}, {"model", "Workers AI model for /cloud ai.run", "text"}, {"embeddingModel", "Workers AI embedding model", "text"}, {"index", "Vectorize index", "text"}, {"databaseId", "D1 database ID", "text"}, {"namespaceId", "KV namespace ID", "text"}, {"bucket", "R2 bucket", "text"}, {"accessKey", "R2 S3 Access Key ID", "text"}, {"secretKey", "R2 S3 Secret Access Key (blank keeps saved value)", "secret"}}
	case "compose":
		return []pluginField{{"to", "Recipient(s)", "text"}, {"subject", "Subject", "text"}, {"text", "Message body (single paragraph; GUI supports multiple lines)", "text"}}
	}
	return nil
}
func (f *pluginForm) value(path string) (map[string]any, string) {
	parts := strings.Split(path, ".")
	value := f.config[f.name]
	if value == nil {
		value = map[string]any{}
		f.config[f.name] = value
	}
	if len(parts) == 2 {
		sub, ok := value[parts[0]].(map[string]any)
		if !ok {
			sub = map[string]any{}
			value[parts[0]] = sub
		}
		return sub, parts[1]
	}
	return value, path
}
func (f *pluginForm) focus() {
	f.input.Reset()
	f.input.EchoMode = textinput.EchoNormal
	if f.index < 0 || f.index >= len(f.fields) {
		return
	}
	field := f.fields[f.index]
	if field.kind == "secret" {
		f.input.EchoMode = textinput.EchoPassword
		return
	}
	value, key := f.value(field.path)
	if v := value[key]; v != nil {
		f.input.SetValue(fmt.Sprint(v))
	}
}
func (f *pluginForm) accept() error {
	field := f.fields[f.index]
	value, key := f.value(field.path)
	raw := f.input.Value()
	switch field.kind {
	case "bool":
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return fmt.Errorf("enter true or false")
		}
		value[key] = v
	case "int":
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return fmt.Errorf("enter a whole number")
		}
		value[key] = v
	default:
		value[key] = raw
	}
	f.index++
	if field.path == "enabled" && value[key] == false {
		f.index = len(f.fields)
	}
	f.focus()
	return nil
}
func (m model) pluginKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	f := m.plugin
	if msg.String() == "ctrl+c" {
		m.cancel()
		return m, tea.Quit
	}
	if f.saving {
		return m, nil
	}
	if msg.String() == "esc" {
		m.plugin = nil
		m.failure = ""
		return m, m.checkConfig()
	}
	if f.index < 0 {
		switch msg.String() {
		case "1":
			f.name = "email"
		case "2":
			f.name = "telegram"
		case "3":
			f.name = "cloudflare"
		default:
			return m, nil
		}
		f.fields = fieldsFor(f.name)
		f.index = 0
		f.focus()
		return m, nil
	}
	if msg.String() == "ctrl+b" && f.index > 0 {
		f.index--
		f.focus()
		return m, nil
	}
	if msg.String() == "enter" {
		m.failure = ""
		if f.index < len(f.fields) {
			if err := f.accept(); err != nil {
				m.failure = err.Error()
			}
			return m, nil
		}
		f.saving = true
		path := "/api/plugins/" + f.name
		body := f.config[f.name]
		if f.name == "compose" {
			path = "/api/plugins/email/send"
			body["requestId"] = f.requestID
		}
		// Marshal now: the asynchronous command must not observe further edits.
		raw, _ := json.Marshal(body)
		return m, func() tea.Msg {
			var result any
			return pluginSaved{Err: m.json("POST", path, json.RawMessage(raw), &result)}
		}
	}
	var cmd tea.Cmd
	f.input, cmd = f.input.Update(msg)
	return m, cmd
}
func (f *pluginForm) view() string {
	if f.index < 0 {
		return "Connections\n\n1 Email plugin · SMTP / IMAP\n2 Telegram Bot API\n3 Cloudflare services\n\nChoose 1–3 · Esc back"
	}
	title := "Configure " + f.name
	if f.index < len(f.fields) {
		return title + fmt.Sprintf(" · %d/%d\n\n", f.index+1, len(f.fields)) + f.fields[f.index].label + "\n" + f.input.View() + "\n\nEnter next · Ctrl+B previous · Esc cancel"
	}
	var b strings.Builder
	b.WriteString(title + "\n\n")
	for _, field := range f.fields {
		if field.kind == "secret" {
			continue
		}
		value, key := f.value(field.path)
		fmt.Fprintf(&b, "%s: %v\n", field.label, value[key])
	}
	if f.saving {
		b.WriteString("\nSaving…")
	} else if f.name == "compose" {
		b.WriteString("\nEnter SEND EMAIL · Ctrl+B edit · Esc cancel")
	} else {
		b.WriteString("\nEnter SAVE CONFIGURATION · Ctrl+B edit · Esc cancel")
	}
	return safe(b.String())
}
func (m model) pluginCommand(text string) (tea.Cmd, bool) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return nil, false
	}
	switch fields[0] {
	case "/clear-secret":
		if len(fields) != 3 {
			return func() tea.Msg {
				return listing{Text: "/clear-secret email|telegram|cloudflare FIELD (disable the plugin first; e.g. imap.password, token, secretKey)"}
			}, true
		}
		name, key := fields[1], fields[2]
		return func() tea.Msg {
			var loaded pluginsLoaded
			if err := m.json("GET", "/api/plugins", nil, &loaded); err != nil {
				return listing{Err: err}
			}
			body, ok := loaded.Config[name]
			if !ok {
				return listing{Text: "Unknown plugin"}
			}
			body["secrets"] = map[string]configcontract.SecretUpdate{key: {Mode: "clear"}}
			var result configcontract.Plugins
			err := m.json("POST", "/api/plugins/"+name, body, &result)
			return listing{Text: "Credential clear request completed.", Err: err}
		}, true
	case "/deliveries":
		return m.pluginRequest("GET", "/api/deliveries", nil), true
	case "/plugins":
		return m.loadPlugins(), true
	case "/test":
		if len(fields) != 2 {
			return func() tea.Msg { return listing{Text: "/test email|telegram|cloudflare"} }, true
		}
		switch fields[1] {
		case "email", "telegram", "cloudflare":
			return m.pluginRequest("POST", "/api/plugins/"+fields[1]+"/test", map[string]any{}), true
		}
		return func() tea.Msg { return listing{Text: "Unknown plugin"} }, true
	case "/email":
		if len(fields) == 1 {
			return m.pluginRequest("GET", "/api/plugins/email/inbox", nil), true
		}
		if len(fields) == 3 {
			return m.pluginRequest("GET", "/api/plugins/email/messages/"+fields[1]+"?validity="+fields[2], nil), true
		}
		if len(fields) == 4 && fields[1] == "analyze" {
			uid, e1 := strconv.ParseUint(fields[2], 10, 32)
			v, e2 := strconv.ParseUint(fields[3], 10, 32)
			if e1 == nil && e2 == nil {
				return m.pluginRequest("POST", "/api/plugins/email/analyze", map[string]any{"uid": uid, "validity": v}), true
			}
		}
		return func() tea.Msg {
			return listing{Text: "/email lists INBOX; /email UID VALIDITY reads; /email analyze UID VALIDITY summarizes with your model."}
		}, true
	case "/cloud":
		if len(fields) < 2 {
			return func() tea.Msg {
				return listing{Text: "/cloud ai.models|ai.run|vectorize.indexes|vectorize.query|d1.databases|d1.query|kv.namespaces|kv.get|r2.buckets|r2.list|r2.get [prompt/search/key/SQL]\nD1 executes your SQL, including writes. Workers AI calls may incur charges."}
			}, true
		}
		argument := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(text, "/cloud")), fields[1]))
		return m.pluginRequest("POST", "/api/plugins/cloudflare/action", map[string]any{"operation": fields[1], "text": argument, "key": argument, "sql": argument}), true
	}
	return nil, false
}
func (m model) pluginRequest(method, path string, body any) tea.Cmd {
	return func() tea.Msg {
		var result any
		err := m.json(method, path, body, &result)
		raw, _ := json.MarshalIndent(result, "", "  ")
		return listing{Text: string(raw), Err: err}
	}
}
