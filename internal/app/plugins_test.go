package app

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/fdkevin0/mob/internal/chat"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/configuration"
	"github.com/fdkevin0/mob/internal/plugins/cloudflare"
	"github.com/fdkevin0/mob/internal/plugins/telegram"
)

func TestPluginConfiguration(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := NewServer(store, chat.Provider{APIKey: "original-key", Model: "original"}, strings.Repeat("t", 32))
	defer srv.Close()
	handler := srv.Handler(nil)
	request := func(method, path, body string, status int) string {
		t.Helper()
		req := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+srv.Token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "secret-token") || strings.Contains(w.Body.String(), "secret-password") {
			t.Fatal("secret leaked")
		}
		return w.Body.String()
	}
	request("GET", "/api/plugins/email/inbox", "", 409)
	request("POST", "/api/plugins/email", `{"enabled":true}`, 400)
	mail := `{"enabled":true,"from":"a@example.org","imap":{"host":"imap.example.org","port":993,"security":"tls","username":"a","password":"secret-password"},"smtp":{"host":"smtp.example.org","port":587,"security":"starttls","username":"a","password":"secret-password"}}`
	request("POST", "/api/plugins/email", mail, 200)
	request("POST", "/api/plugins/email", strings.ReplaceAll(mail, `"password":"secret-password"`, `"password":""`), 200)
	stored, err := srv.pluginConfig()
	if err != nil || stored.Email.IMAP.Password != "secret-password" {
		t.Fatal("blank edit cleared saved password")
	}
	request("POST", "/api/plugins/email", strings.ReplaceAll(strings.ReplaceAll(mail, "imap.example.org", "attacker.example.org"), `"password":"secret-password"`, `"password":""`), 400)
	cf := cloudflare.Config{Enabled: true, UseForChat: true, Token: "secret-token", AccountID: strings.Repeat("a", 32), Model: "@cf/chat"}
	raw, _ := json.Marshal(cf)
	request("POST", "/api/plugins/cloudflare", string(raw), 200)
	p := srv.Provider()
	if p.APIKey != "secret-token" || !strings.HasSuffix(p.BaseURL, "/ai/v1") {
		t.Fatal("Workers AI not selected")
	}
	request("POST", "/api/config", `{"apiKey":"replacement"}`, 200)
	p = srv.Provider()
	if p.APIKey != "secret-token" {
		t.Fatal("model setup overwrote Cloudflare token")
	}
	cf.Enabled = false
	cf.Token = ""
	raw, _ = json.Marshal(cf)
	request("POST", "/api/plugins/cloudflare", string(raw), 200)
	p = srv.Provider()
	if p.APIKey != "replacement" {
		t.Fatal("default provider not restored")
	}
	request("GET", "/api/plugins", "", 200)
	req := httptest.NewRequest("GET", "http://127.0.0.1/api/plugins", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("plugin config lacked local authentication")
	}
}

type pluginTransport func(*http.Request) (*http.Response, error)

func (f pluginTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestTelegramBridgeIsolationAndDeduplication(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := NewServer(store, chat.Provider{Demo: true}, strings.Repeat("t", 32))
	defer srv.Close()
	sent := make(chan string, 4)
	var polls atomic.Int32
	srv.HTTPTransport = pluginTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.telegram.org" {
			t.Fatalf("unexpected destination: %s", r.URL.Host)
			return nil, nil
		}
		result := `{"ok":true,"result":{}}`
		switch {
		case strings.HasSuffix(r.URL.Path, "/getMe"):
			result = `{"ok":true,"result":{"id":123,"username":"fixture"}}`
		case strings.HasSuffix(r.URL.Path, "/getUpdates"):
			if polls.Add(1) > 1 {
				<-r.Context().Done()
				return nil, r.Context().Err()
			}
			result = `{"ok":true,"result":[{"update_id":1,"message":{"text":"unauthorized","from":{"id":9},"chat":{"id":9,"type":"private"}}},{"update_id":2,"message":{"text":"group","from":{"id":42},"chat":{"id":-42,"type":"group"}}},{"update_id":3,"message":{"text":"hello bridge","from":{"id":42},"chat":{"id":42,"type":"private"}}}]}`
		case strings.HasSuffix(r.URL.Path, "/sendMessage"):
			var body struct {
				ChatID int64  `json:"chat_id"`
				Text   string `json:"text"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if body.ChatID != 42 {
				t.Error("reply escaped allowed user")
			}
			sent <- body.Text
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(result)), Header: make(http.Header)}, nil
	})
	c := telegram.Config{Enabled: true, Token: "123:secret", UserID: 42, Transport: srv.HTTPTransport}
	if err = store.SaveSetting("plugins", configuration.Plugins{Telegram: c}); err != nil {
		t.Fatal(err)
	}
	if err = srv.StartPlugins(); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-sent:
		if !strings.Contains(reply, "hello bridge") {
			t.Fatalf("missing assistant reply: %s", reply)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not reply")
	}
	// Cancel and join before restoring the transport or inspecting final receipt state.
	srv.closePlugins()
	list, _ := store.List()
	if len(list) != 1 {
		t.Fatalf("unauthorized input reached history: %+v", list)
	}
	history, _ := store.History(list[0].ID)
	if len(history) != 2 || !strings.Contains(chat.Text(history[0]), "hello bridge") {
		t.Fatalf("history: %+v", history)
	}
	var u telegram.Update
	json.Unmarshal([]byte(`{"update_id":3,"message":{"text":"hello bridge","from":{"id":42},"chat":{"id":42,"type":"private"}}}`), &u)
	if err = (&telegram.Service{Store: store, Conversation: srv.ConversationService}).Message(context.Background(), c, "123", u); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sent:
		t.Fatal("duplicate Telegram delivery")
	default:
	}
	var offset int64
	store.Setting("telegram-offset:123", &offset)
	// A shutdown immediately after SMTP-like delivery may precede offset save;
	// the persisted receipt still prevents repeat model calls and messages.
	if offset != 0 && offset != 3 && offset != 4 {
		t.Fatalf("invalid offset %d", offset)
	}
}
func TestEmailDuplicateSendDoesNotReconnect(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := NewServer(store, chat.Provider{Demo: true}, strings.Repeat("t", 32))
	defer srv.Close()
	var c configuration.Plugins
	c.Email.Enabled = true
	store.SaveSetting("plugins", c)
	id := chat.NewID()
	store.AcceptDelivery("email:"+id, "sending")
	body, _ := json.Marshal(map[string]any{"requestId": id, "to": "a@example.org", "subject": "test", "text": "hello"})
	req := httptest.NewRequest("POST", "http://127.0.0.1/api/plugins/email/send", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+srv.Token)
	w := httptest.NewRecorder()
	srv.Handler(nil).ServeHTTP(w, req)
	if w.Code != 409 {
		t.Fatalf("duplicate send should not connect to SMTP: %d %s", w.Code, w.Body.String())
	}
}
