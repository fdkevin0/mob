package tui

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"github.com/fdkevin0/mob/internal/app"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/internal/provider"
)

func TestTUIUsesSharedService(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler(nil))
	defer httpSrv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	m := model{configured: true, connection: local.Connection{URL: httpSrv.URL, Token: srv.Token()}, ctx: ctx, cancel: cancel, input: textarea.New(), viewport: viewport.New(), width: 80}
	loaded := m.load("", false)().(snapshot)
	if loaded.Err != nil {
		t.Fatal(loaded.Err)
	}
	updated, _ := m.Update(loaded)
	m = updated.(model)
	m.input.SetValue("你好，终端")
	updated, command := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = updated.(model)
	if !m.busy {
		t.Fatal("enter did not start streaming")
	}
	batch, ok := command().(tea.BatchMsg)
	if !ok || len(batch) != 2 {
		t.Fatal("missing stream producer / consumer")
	}
	go batch[0]()
	for {
		event := batch[1]().(streamEvent)
		updated, cmd := m.Update(event)
		m = updated.(model)
		if event.Done {
			loaded := cmd().(snapshot)
			updated, _ = m.Update(loaded)
			m = updated.(model)
			break
		}
		batch[1] = cmd
	}
	if len(m.messages) != 2 || !strings.Contains(chat.Text(m.messages[1]), "你好，终端") {
		t.Fatalf("missing shared history: %+v", m.messages)
	}
	if safe("hello\x1b[31m\x07world") != "hello[31mworld" {
		t.Fatal("terminal control bytes escaped sanitization")
	}
	m.generation = 2
	updated, _ = m.Update(snapshot{Generation: 1, ID: "stale"})
	if updated.(model).id == "stale" {
		t.Fatal("stale poll changed active conversation")
	}
}

func TestTUIConnectsAndShowsModel(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler(nil))
	defer httpSrv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := model{connection: local.Connection{URL: httpSrv.URL, Token: srv.Token()}, ctx: ctx, cancel: cancel}
	msg := m.checkConfig()().(modelConfiguration)
	if msg.Err != nil || msg.DefaultModel != "demo/echo" {
		t.Fatalf("config %+v", msg)
	}
	updated, cmd := m.Update(msg)
	m = updated.(model)
	if !m.configured || cmd == nil {
		t.Fatal("did not enter chat")
	}
	updated, _ = m.Update(cmd())
	m = updated.(model)
	if m.id == "" || !strings.Contains(m.status, "demo/echo") {
		t.Fatalf("status %q", m.status)
	}
}

func TestTUIPluginWizardMasksAndSaves(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler(nil))
	defer httpSrv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := model{connection: local.Connection{URL: httpSrv.URL, Token: srv.Token()}, ctx: ctx, cancel: cancel, input: textarea.New(), viewport: viewport.New()}
	updated, _ := m.Update(m.loadPlugins()())
	m = updated.(model)
	// The menu lists the plugins the service describes with fields.
	if menu := m.plugin.view(); !strings.Contains(menu, "1 Email plugin · SMTP / IMAP\n2 Telegram Bot API\n3 Cloudflare services\n") || strings.Contains(menu, "WeChat") || !strings.Contains(menu, "Choose 1–3") {
		t.Fatalf("menu: %q", menu)
	}
	if updated, _ = m.Update(tea.KeyPressMsg{Code: '4'}); updated.(model).plugin.index >= 0 {
		t.Fatal("chose a plugin outside the menu")
	}
	updated, _ = m.Update(tea.KeyPressMsg{Code: '3'})
	m = updated.(model)
	values := []string{"true", strings.Repeat("a", 32), "secret-token", "@cf/chat", "@cf/embed", "index", "db", "ns", "bucket", "access-key", "secret-r2"}
	for i, value := range values {
		m.plugin.input.SetValue(value)
		if m.plugin.fields[i].Kind == "secret" && strings.Contains(m.plugin.input.View(), value) {
			t.Fatal("wizard exposed secret")
		}
		updated, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
		m = updated.(model)
	}
	if strings.Contains(m.plugin.view(), "secret-token") || strings.Contains(m.plugin.view(), "secret-r2") {
		t.Fatal("review exposed secret")
	}
	updated, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = updated.(model)
	if cmd == nil || !m.plugin.saving {
		t.Fatal("missing save command")
	}
	result := cmd().(pluginSaved)
	if result.Err != nil {
		t.Fatal(result.Err)
	}
	updated, _ = m.Update(result)
	m = updated.(model)
	if m.plugin != nil || m.status != "Saved" {
		t.Fatal("wizard did not close")
	}
}

func TestTUICompletesCommands(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler(nil))
	defer httpSrv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	input := textarea.New()
	styles := input.Styles()
	styles.Cursor.Blink = false // a blink tick would stall the command loop below
	input.SetStyles(styles)
	input.Focus()
	m := model{configured: true, connection: local.Connection{URL: httpSrv.URL, Token: srv.Token()}, ctx: ctx, cancel: cancel, input: input, viewport: viewport.New(), width: 80}
	updated, _ := m.Update(m.load("", false)())
	m = updated.(model)
	press := func(key tea.KeyPressMsg) {
		t.Helper()
		updated, cmd := m.Update(key)
		m = updated.(model)
		// Run completion requests the way Bubble Tea would.
		for cmd != nil {
			msg := cmd()
			if batch, ok := msg.(tea.BatchMsg); ok {
				cmd = nil
				for _, c := range batch {
					if c == nil {
						continue
					}
					if result, ok := c().(completions); ok {
						updated, _ = m.Update(result)
						m = updated.(model)
					}
				}
				continue
			}
			result, ok := msg.(completions)
			if !ok {
				break
			}
			updated, cmd = m.Update(result)
			m = updated.(model)
		}
	}
	for _, r := range "/mo" {
		press(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	if len(m.suggestions) != 2 || m.suggestions[0].Value != "/model" || !strings.Contains(m.View().Content, "Show or switch") {
		t.Fatalf("command suggestions: %+v", m.suggestions)
	}
	press(tea.KeyPressMsg{Code: tea.KeyDown})
	press(tea.KeyPressMsg{Code: tea.KeyTab})
	if m.input.Value() != "/models " || len(m.suggestions) != 0 {
		t.Fatalf("tab accepted %q, left %+v", m.input.Value(), m.suggestions)
	}
	m.input.Reset()
	for _, r := range "/model " {
		press(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	if len(m.suggestions) < 2 || m.suggestions[0].Value != "default" || m.suggestions[1].Value != "demo/echo" {
		t.Fatalf("model suggestions: %+v", m.suggestions)
	}
	press(tea.KeyPressMsg{Code: tea.KeyEscape})
	if len(m.suggestions) != 0 {
		t.Fatal("escape kept suggestions")
	}
	m.input.SetValue("/models")
	m.suggestions = []chat.Suggestion{{Value: "/models"}}
	updated, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m = updated.(model); !m.running || m.suggestions != nil {
		t.Fatal("enter on a complete command did not send it")
	}
}

func TestTUIRunsCommandsThroughService(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler(nil))
	defer httpSrv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	m := model{configured: true, connection: local.Connection{URL: httpSrv.URL, Token: srv.Token()}, ctx: ctx, cancel: cancel, input: textarea.New(), viewport: viewport.New(), width: 80}
	updated, _ := m.Update(m.load("", false)())
	m = updated.(model)
	first := m.id
	enter := func(text string) tea.Cmd {
		t.Helper()
		m.input.SetValue(text)
		updated, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
		m = updated.(model)
		if !m.running {
			t.Fatalf("%s did not go to the service", text)
		}
		updated, cmd = m.Update(cmd())
		m = updated.(model)
		return cmd
	}
	if cmd := enter("/list"); cmd != nil || !strings.Contains(m.listText, first) {
		t.Fatalf("/list: %q", m.listText)
	}
	updated, _ = m.Update(enter("/new")())
	if m = updated.(model); m.id == first || m.id == "" {
		t.Fatalf("/new kept conversation %s", m.id)
	}
	if loaded, ok := enter("/plugins")().(pluginsLoaded); !ok || loaded.Err != nil {
		t.Fatal("/plugins did not load the plugin configuration")
	}
	if enter("/mail"); m.plugin == nil || m.plugin.name != "compose" {
		t.Fatal("/mail did not open the compose form")
	}
	m.plugin = nil
	if enter("/models"); !m.busy || chat.Text(m.messages[len(m.messages)-1]) != "/models" {
		t.Fatal("/models was not sent as chat")
	}
}

func TestTUIRendersMarkdown(t *testing.T) {
	m := model{input: textarea.New(), viewport: viewport.New(), width: 80}
	m.viewport.SetWidth(76)
	m.viewport.SetHeight(30)
	m.messages = []chat.Message{
		{ID: "u", Role: "user", Parts: []chat.Part{{"type": "text", "text": "**not bold** for users"}}},
		{ID: "a", Role: "assistant", Parts: []chat.Part{{"type": "text", "text": "**Current model:** `demo/echo`\n\n| Model | Traits |\n| --- | --- |\n| demo/echo | tools \x1b]52;c;ZXZpbA==\x07|"}}},
	}
	m.render()
	content := m.viewport.GetContent()
	if !strings.Contains(content, "**not bold**") {
		t.Fatal("user text was rendered as Markdown")
	}
	if strings.Contains(content, "**Current model:**") || strings.Contains(content, "| --- |") || !strings.Contains(content, "demo/echo") {
		t.Fatalf("assistant Markdown was not rendered:\n%s", content)
	}
	if strings.Contains(content, "\x1b]52") || strings.Contains(content, "\x07") {
		t.Fatal("a terminal escape from model output reached the screen")
	}
	m.listText = "**Deliveries:** none yet."
	m.render()
	if content := m.viewport.GetContent(); strings.Contains(content, "**") || !strings.Contains(content, "Deliveries:") {
		t.Fatalf("command result was not rendered:\n%s", content)
	}
	m.markdown.cache["sentinel"] = "kept"
	m.width = 60
	m.render()
	if _, ok := m.markdown.cache["sentinel"]; ok {
		t.Fatal("a width change kept output wrapped for the old width")
	}
}

func TestTUIIgnoresSuggestionsForOlderText(t *testing.T) {
	m := model{configured: true, id: "c", input: textarea.New(), viewport: viewport.New(), width: 80, ctx: context.Background()}
	m.input.Focus()
	m.input.SetValue("/mo")
	updated, _ := m.Update(completions{Seq: m.completionSeq, Text: "/mo", List: []chat.Suggestion{{Value: "/model"}, {Value: "/models"}}})
	m = updated.(model)
	// The user finishes typing before the answer for "/models" arrives.
	m.input.SetValue("/models")
	updated, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	if m = updated.(model); m.input.Value() != "/models" {
		t.Fatalf("tab applied a suggestion for older text: %q", m.input.Value())
	}
	updated, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m = updated.(model); !m.running || m.input.Value() != "" {
		t.Fatalf("enter did not send /models; input %q", m.input.Value())
	}
}

func TestCommandRequestsGetThePluginTimeout(t *testing.T) {
	for path, want := range map[string]time.Duration{
		"/api/commands/run":       60 * time.Second,
		"/api/plugins/email/send": 60 * time.Second,
		"/api/commands/complete":  10 * time.Second,
		"/api/conversations":      10 * time.Second,
	} {
		if got := timeoutFor(path); got != want {
			t.Errorf("%s: %s, want %s", path, got, want)
		}
	}
}

func TestLongPasteIsSentWhole(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := textarea.New()
	input.CharLimit, input.MaxHeight = 0, 0
	input.Focus()
	m := model{configured: true, id: chat.NewID(), ctx: ctx, cancel: cancel, input: input, viewport: viewport.New(), width: 80}
	// More lines than the input component itself keeps.
	long := strings.Repeat("x\n", 10001) + "TAIL"
	updated, _ := m.Update(tea.PasteMsg{Content: long})
	m = updated.(model)
	if got := m.input.Value(); !pasted.MatchString(got) || !strings.HasPrefix(got, "[Pasted text #1 · 10002 lines · ") {
		t.Fatalf("long paste shown as %q", got)
	}
	updated, _ = m.Update(tea.PasteMsg{Content: " and a note"})
	m = updated.(model)
	updated, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = updated.(model)
	if last := m.messages[len(m.messages)-1]; chat.Text(last) != long+" and a note" {
		t.Fatalf("sent %d bytes, want %d", len(chat.Text(last)), len(long)+len(" and a note"))
	}
	if m.input.Value() != "" || m.pastes != nil {
		t.Fatal("paste kept after sending")
	}
}

func TestPastesSurviveTheirOwnLabelsAndAddUp(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fresh := func() model {
		input := textarea.New()
		input.CharLimit, input.MaxHeight = 0, 0
		input.Focus()
		return model{configured: true, id: chat.NewID(), ctx: ctx, cancel: cancel, input: input, viewport: viewport.New(), width: 80}
	}
	submit := func(m model, pastes ...string) string {
		for _, p := range pastes {
			updated, _ := m.Update(tea.PasteMsg{Content: p})
			m = updated.(model)
		}
		updated, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
		m = updated.(model)
		return chat.Text(m.messages[len(m.messages)-1])
	}
	// Text that looks like a placeholder, inside a paste or before one,
	// stays as it was; only the placeholders the input made bring in pastes.
	second := strings.Repeat("y\n", 10001) + "END"
	first := "[Pasted text #2 · 10002 lines]\n" + strings.Repeat("x\n", 200)
	if got := submit(fresh(), first, second); got != first+second {
		t.Fatalf("labels in pasted text were expanded: %d bytes, want %d", len(got), len(first+second))
	}
	quote := "Quote [Pasted text #1 · 10002 lines]: "
	if got := submit(fresh(), quote, second); got != quote+second {
		t.Fatalf("a quoted label took the paste: %d bytes, want %d", len(got), len(quote+second))
	}
	// Short pastes that together pass the input's line limit are all kept.
	var parts []string
	for range 102 {
		parts = append(parts, strings.Repeat("z\n", 99))
	}
	parts = append(parts, "TAIL")
	if got, want := submit(fresh(), parts...), strings.Join(parts, ""); got != want {
		t.Fatalf("pastes past the input's limit were cut: %d bytes, want %d", len(got), len(want))
	}
}
