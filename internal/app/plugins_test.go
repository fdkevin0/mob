package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/provider"
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
	models := provider.Memory(provider.File{Default: "work/original", Providers: []provider.Provider{{ID: "work", Chat: "https://relay.example/v1", Key: "secret-token"}}})
	srv := NewServer(store, models, strings.Repeat("t", 32))
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
	cf := cloudflare.Config{Enabled: true, Token: "secret-token", AccountID: strings.Repeat("a", 32), Model: "@cf/chat"}
	raw, _ := json.Marshal(cf)
	request("POST", "/api/plugins/cloudflare", string(raw), 200)
	if !strings.Contains(request("GET", "/api/config", "", 200), `"defaultModel":"work/original"`) {
		t.Fatal("default model missing")
	}
	// Providers are listed with their keys masked; keys are set through providers.json only.
	if !strings.Contains(request("GET", "/api/providers", "", 200), `"key":"sec…oken"`) {
		t.Fatal("provider key not masked")
	}
	request("POST", "/api/config", `{"apiKey":"replacement"}`, 405)
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
	srv := NewServer(store, provider.Offline(), strings.Repeat("t", 32))
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
	srv := NewServer(store, provider.Offline(), strings.Repeat("t", 32))
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

func TestSavingAChannelRestartsIt(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := NewServer(store, provider.Memory(provider.File{}), strings.Repeat("t", 32))
	defer srv.Close()
	var polls atomic.Int32
	srv.HTTPTransport = pluginTransport(func(r *http.Request) (*http.Response, error) {
		polls.Add(1)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	if err := srv.StartPlugins(); err != nil {
		t.Fatal(err)
	}
	status := func() string {
		var body struct {
			TelegramStatus string `json:"telegramStatus"`
			WechatStatus   string `json:"wechatStatus"`
		}
		req := httptest.NewRequest("GET", "http://127.0.0.1/api/plugins", nil)
		req.Header.Set("Authorization", "Bearer "+srv.Token)
		w := httptest.NewRecorder()
		srv.Handler(nil).ServeHTTP(w, req)
		if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.WechatStatus != "Disabled" {
			t.Fatalf("wechat status: %q", body.WechatStatus)
		}
		return body.TelegramStatus
	}
	if got := status(); got != "Disabled" {
		t.Fatalf("before saving: %q", got)
	}
	if _, err := srv.updatePlugin("telegram", []byte(`{"enabled":true,"token":"123:secret","userId":42}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for polls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if polls.Load() == 0 || status() == "Disabled" {
		t.Fatalf("enabled channel did not start: %d polls, %q", polls.Load(), status())
	}
	if _, err := srv.updatePlugin("telegram", []byte(`{"enabled":false,"userId":42}`)); err != nil {
		t.Fatal(err)
	}
	if got := status(); got != "Disabled" {
		t.Fatalf("after disabling: %q", got)
	}
	srv.closePlugins()
	var stopping *chat.CommandError
	if _, err := srv.updatePlugin("telegram", []byte(`{"enabled":false,"userId":42}`)); !errors.As(err, &stopping) || stopping.Status != 503 {
		t.Fatalf("saved while stopping: %v", err)
	}
}

func TestPluginToolsFollowTheirPlugins(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer srv.Close()
	available := func() (names []string) {
		for _, tool := range srv.Tools.List() {
			if tool.Available == nil || tool.Available() {
				names = append(names, tool.Name)
			}
		}
		return names
	}
	if got := strings.Join(available(), " "); got != "datetime remember" {
		t.Fatalf("with plugins off: %s", got)
	}
	var c configuration.Plugins
	c.Email.Enabled = true
	c.Cloudflare.Enabled = true
	store.SaveSetting("plugins", c)
	if got := strings.Join(available(), " "); got != "datetime remember email_inbox email_read email_send cloudflare" {
		t.Fatalf("with plugins on: %s", got)
	}
}

func TestPluginRoutes(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer srv.Close()
	// The transport is set after the server is built, as the CLI and tests do.
	var hosts []string
	srv.HTTPTransport = pluginTransport(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true,"result":[]}`)), Header: make(http.Header)}, nil
	})
	handler := srv.Handler(nil)
	request := func(method, path, body string) int {
		t.Helper()
		req := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+srv.Token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w.Code
	}
	var c configuration.Plugins
	c.Email.Enabled = true
	c.Cloudflare = cloudflare.Config{Enabled: true, AccountID: strings.Repeat("a", 32), Token: "secret-token"}
	store.SaveSetting("plugins", c)
	if code := request("POST", "/api/plugins/email/analyze", `{"uid":1,"validity":1,"extra":true}`); code != 400 {
		t.Fatalf("unknown field: %d", code)
	}
	if code := request("GET", "/api/plugins/email/messages/0?validity=1", ""); code != 400 {
		t.Fatalf("invalid message identity: %d", code)
	}
	// A valid action that fills the 256 KiB limit, then trailing content.
	action := `{"operation":"d1.databases","text":""}`
	action = action[:len(action)-2] + strings.Repeat("x", 256<<10-len(action)) + `"}`
	for _, trailing := range []string{" ", "{}"} {
		if code := request("POST", "/api/plugins/cloudflare/action", action+trailing); code != 400 || len(hosts) != 0 {
			t.Fatalf("an action past the size limit ran: %d %v", code, hosts)
		}
	}
	if code := request("POST", "/api/plugins/cloudflare/action", `{"operation":"d1.databases"}`); code != 200 || len(hosts) != 1 || hosts[0] != "api.cloudflare.com" {
		t.Fatalf("cloudflare action: %d %v", code, hosts)
	}
	request("POST", "/api/plugins/wechat_ilink/qrcode", "")
	if len(hosts) != 2 {
		t.Fatalf("the QR code request did not use the server's transport: %v", hosts)
	}
	if code := request("POST", "/api/plugins/wechat_ilink/message", `{"senderId":"a","text":"hi"}`); code != 409 {
		t.Fatalf("message to a disabled WeChat plugin: %d", code)
	}
	if code := request("GET", "/api/plugins/telegram/inbox", ""); code != 404 && code != 405 {
		t.Fatalf("a route no plugin serves: %d", code)
	}
}
