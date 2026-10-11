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
	m := model{configured: true, connection: local.Connection{URL: httpSrv.URL, Token: srv.Token}, ctx: ctx, cancel: cancel, input: textarea.New(), viewport: viewport.New(), width: 80}
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
	m := model{connection: local.Connection{URL: httpSrv.URL, Token: srv.Token}, ctx: ctx, cancel: cancel}
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
	m := model{connection: local.Connection{URL: httpSrv.URL, Token: srv.Token}, ctx: ctx, cancel: cancel, input: textarea.New(), viewport: viewport.New()}
	updated, _ := m.Update(m.loadPlugins()())
	m = updated.(model)
	updated, _ = m.Update(tea.KeyPressMsg{Code: '3'})
	m = updated.(model)
	values := []string{"true", strings.Repeat("a", 32), "secret-token", "@cf/chat", "@cf/embed", "index", "db", "ns", "bucket", "access-key", "secret-r2"}
	for i, value := range values {
		m.plugin.input.SetValue(value)
		if m.plugin.fields[i].kind == "secret" && strings.Contains(m.plugin.input.View(), value) {
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
	m := model{configured: true, connection: local.Connection{URL: httpSrv.URL, Token: srv.Token}, ctx: ctx, cancel: cancel, input: input, viewport: viewport.New(), width: 80}
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
	if m = updated.(model); !m.busy || m.suggestions != nil {
		t.Fatal("enter on a complete command did not send it")
	}
}
