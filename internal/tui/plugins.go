package tui

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
)

type pluginField struct {
	Path  string `json:"path"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

// pluginSection is a plugin as the service describes its configuration.
type pluginSection struct {
	Name   string        `json:"name"`
	Title  string        `json:"title"`
	Fields []pluginField `json:"fields"`
}
type pluginForm struct {
	name      string
	config    map[string]map[string]any
	sections  []pluginSection
	fields    []pluginField
	index     int
	input     textinput.Model
	saving    bool
	requestID string
}
type pluginsLoaded struct {
	Config   map[string]map[string]any `json:"config"`
	Sections []pluginSection           `json:"sections"`
	Err      error
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

// composeFields are the message the /mail form sends.
var composeFields = []pluginField{{"to", "Recipient(s)", "text"}, {"subject", "Subject", "text"}, {"text", "Message body (single paragraph; GUI supports multiple lines)", "text"}}

// choices are the plugins this form can configure: those with fields.
func (f *pluginForm) choices() []pluginSection {
	var list []pluginSection
	for _, s := range f.sections {
		if len(s.Fields) > 0 {
			list = append(list, s)
		}
	}
	return list
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
	if field.Kind == "secret" {
		f.input.EchoMode = textinput.EchoPassword
		return
	}
	value, key := f.value(field.Path)
	if v := value[key]; v != nil {
		f.input.SetValue(fmt.Sprint(v))
	}
}
func (f *pluginForm) accept() error {
	field := f.fields[f.index]
	value, key := f.value(field.Path)
	raw := f.input.Value()
	switch field.Kind {
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
	if field.Path == "enabled" && value[key] == false {
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
		choices := f.choices()
		n, err := strconv.Atoi(msg.String())
		if err != nil || n < 1 || n > len(choices) {
			return m, nil
		}
		f.name, f.fields = choices[n-1].Name, choices[n-1].Fields
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
		choices := f.choices()
		var b strings.Builder
		b.WriteString("Connections\n\n")
		for i, s := range choices {
			fmt.Fprintf(&b, "%d %s\n", i+1, s.Title)
		}
		fmt.Fprintf(&b, "\nChoose 1–%d · Esc back", len(choices))
		return safe(b.String())
	}
	title := "Configure " + f.name
	if f.index < len(f.fields) {
		return title + fmt.Sprintf(" · %d/%d\n\n", f.index+1, len(f.fields)) + f.fields[f.index].Label + "\n" + f.input.View() + "\n\nEnter next · Ctrl+B previous · Esc cancel"
	}
	var b strings.Builder
	b.WriteString(title + "\n\n")
	for _, field := range f.fields {
		if field.Kind == "secret" {
			continue
		}
		value, key := f.value(field.Path)
		fmt.Fprintf(&b, "%s: %v\n", field.Label, value[key])
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
