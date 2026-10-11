package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/plugins/telegram"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestTelegramPersistenceFailureDoesNotAcknowledge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mob.sqlite")
	s, err := chat.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// A real SQLite write failure after offset lookup, before durable acceptance.
	db, _ := sql.Open("sqlite", path)
	defer db.Close()
	if _, err = db.Exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON deliveries BEGIN SELECT RAISE(FAIL,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(s, chat.Provider{Demo: true}, "token")
	defer server.Close()
	polls := 0
	c := telegram.Config{Enabled: true, Token: "123:secret", UserID: 42}
	c.Transport = pluginTransport(func(r *http.Request) (*http.Response, error) {
		result := `{"ok":true,"result":{}}`
		if strings.HasSuffix(r.URL.Path, "getUpdates") {
			polls++
			if polls > 1 {
				t.Fatal("poller acknowledged an unpersisted update")
			}
			result = `{"ok":true,"result":[{"update_id":5,"message":{"text":"hello","from":{"id":42},"chat":{"id":42,"type":"private"}}}]}`
		}
		if strings.HasSuffix(r.URL.Path, "sendMessage") {
			t.Fatal("sent without durable receipt")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(result)), Header: make(http.Header)}, nil
	})
	(&telegram.Service{Store: s, Conversation: server.ConversationService}).Loop(context.Background(), c, func(string) {})
	var offset int64
	if err = s.Setting("telegram-offset:123", &offset); err != nil || offset != 0 {
		t.Fatalf("acknowledged failed write: %d %v", offset, err)
	}
}

func TestTelegramTerminalDeliveryNeverResends(t *testing.T) {
	s, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server := NewServer(s, chat.Provider{Demo: true}, "token")
	defer server.Close()
	c := telegram.Config{Token: "123:secret", UserID: 42, Transport: pluginTransport(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected resend"); return nil, nil })}
	var update telegram.Update
	if err = json.Unmarshal([]byte(`{"update_id":5,"message":{"text":"hello","from":{"id":42},"chat":{"id":42,"type":"private"}}}`), &update); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"sent", "cancelled", "failed-or-unknown", "processing-failed"} {
		if _, err = s.AcceptDelivery("tg:123:5", state); err != nil {
			t.Fatal(err)
		}
		if err = s.UpdateDelivery("tg:123:5", state, "reply", nil); err != nil {
			t.Fatal(err)
		}
		if err = (&telegram.Service{Store: s, Conversation: server.ConversationService}).Message(context.Background(), c, "123", update); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTelegramCancellationAndProcessingErrorAreDurable(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server := NewServer(store, chat.Provider{}, "token")
	defer server.Close()
	var update telegram.Update
	json.Unmarshal([]byte(`{"update_id":7,"message":{"text":"hello","from":{"id":42},"chat":{"id":42,"type":"private"}}}`), &update)
	sent := 0
	c := telegram.Config{Token: "123:secret", UserID: 42, Transport: pluginTransport(func(*http.Request) (*http.Response, error) {
		sent++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true,"result":{}}`))}, nil
	})}
	service := &telegram.Service{Store: store, Conversation: server.ConversationService}
	if err = service.Message(context.Background(), c, "123", update); err == nil {
		t.Fatal("missing model should fail processing")
	}
	d, err := store.Delivery("tg:123:7")
	if err != nil || d.State != "processing-failed" || d.Error == "" || sent != 1 {
		t.Fatalf("processing failure: %+v %v", d, err)
	}
	update.ID = 8
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = service.Message(ctx, c, "123", update); err == nil {
		t.Fatal("cancelled processing succeeded")
	}
	d, err = store.Delivery("tg:123:8")
	if err != nil || d.State != "cancelled" || sent != 1 {
		t.Fatalf("cancellation: %+v %v", d, err)
	}
	if err = service.Message(context.Background(), c, "123", update); err != nil || sent != 1 {
		t.Fatal("cancelled delivery resent")
	}
}
