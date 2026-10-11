package tui

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"github.com/fdkevin0/mob/internal/app"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/local"
)

func TestTUIUsesSharedService(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, chat.Provider{Demo: true}, strings.Repeat("t", 32))
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

func TestTUISetup(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, chat.Provider{}, strings.Repeat("t", 32))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler(nil))
	defer httpSrv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	key := textinput.New()
	key.EchoMode = textinput.EchoPassword
	key.Focus()
	m := model{connection: local.Connection{URL: httpSrv.URL, Token: srv.Token}, ctx: ctx, cancel: cancel, key: key}
	msg := m.checkConfig("")().(modelConfiguration)
	if msg.Err != nil || msg.Configured {
		t.Fatal("expected missing key")
	}
	updated, _ := m.Update(msg)
	m = updated.(model)
	m.key.SetValue("secret-key")
	if strings.Contains(m.key.View(), "secret-key") {
		t.Fatal("key is visible")
	}
	updated, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = updated.(model)
	if !m.saving || cmd == nil {
		t.Fatal("setup did not save")
	}
	updated, cmd = m.Update(cmd())
	m = updated.(model)
	if !m.configured || m.key.Value() != "" || cmd == nil {
		t.Fatal("setup did not enter chat and clear key")
	}
	if got := cmd().(snapshot); got.Err != nil || got.ID == "" {
		t.Fatalf("chat failed: %+v", got)
	}
}

func TestTUIPluginWizardMasksAndSaves(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := app.NewServer(store, chat.Provider{}, strings.Repeat("t", 32))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler(nil))
	defer httpSrv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := model{connection: local.Connection{URL: httpSrv.URL, Token: srv.Token}, ctx: ctx, cancel: cancel, input: textarea.New(), viewport: viewport.New(), key: textinput.New()}
	updated, _ := m.Update(m.loadPlugins()())
	m = updated.(model)
	updated, _ = m.Update(tea.KeyPressMsg{Code: '3'})
	m = updated.(model)
	values := []string{"true", strings.Repeat("a", 32), "secret-token", "true", "@cf/chat", "@cf/embed", "index", "db", "ns", "bucket", "access-key", "secret-r2"}
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
	updated, cmd = m.Update(result)
	m = updated.(model)
	if m.plugin != nil {
		t.Fatal("wizard did not close")
	}
	status := cmd().(modelConfiguration)
	if status.Err != nil || !status.Configured {
		t.Fatal("Workers AI did not satisfy startup configuration")
	}
}
