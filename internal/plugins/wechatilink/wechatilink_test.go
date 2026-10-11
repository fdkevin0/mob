package wechatilink_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/plugins/wechatilink"
	"github.com/fdkevin0/mob/internal/provider"
)

func TestWeChatILinkConfig(t *testing.T) {
	c := wechatilink.Config{
		Enabled:      true,
		BaseURL:      "https://ilinkai.weixin.qq.com",
		BotToken:     "test-token-12345",
		BotID:        "bot_wx_test",
		AllowedUsers: []string{"wx_alice", "wx_bob"},
	}

	if err := c.Validate(); err != nil {
		t.Fatalf("validation failed: %v", err)
	}

	if !c.IsUserAllowed("wx_alice") {
		t.Fatal("wx_alice should be allowed")
	}
	if c.IsUserAllowed("wx_charlie") {
		t.Fatal("wx_charlie should not be allowed")
	}

	pub := c.Public()
	if pub.BotToken != "" || !pub.HasToken {
		t.Fatalf("public config token sanitization failed: %+v", pub)
	}

	testRes, err := c.Test(context.Background())
	if err != nil {
		t.Fatalf("test failed: %v", err)
	}
	m, ok := testRes.(map[string]any)
	if !ok || m["status"] != "ready" {
		t.Fatalf("unexpected test output: %+v", testRes)
	}
}

func TestWeChatILinkHTTPClient(t *testing.T) {
	mux := http.NewServeMux()

	// 1. Mock QRCode endpoint
	mux.HandleFunc("POST /ilink/bot/get_bot_qrcode", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"qrcode":             "qr_test_abc",
			"qrcode_img_content": "http://example.com/qr.png",
		})
	})

	// 2. Mock QRCode Status endpoint
	mux.HandleFunc("GET /ilink/bot/get_qrcode_status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":        "confirmed",
			"bot_token":     "tok_confirmed_999",
			"ilink_bot_id":  "bot_wx_1",
			"ilink_user_id": "user_wx_alice",
		})
	})

	// 3. Mock getupdates endpoint
	mux.HandleFunc("POST /ilink/bot/getupdates", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ret": 0,
			"msgs": []map[string]any{
				{
					"msg_id":        "msg_1",
					"from_user_id":  "wx_alice",
					"context_token": "ctx_123",
					"item_list": []map[string]any{
						{"type": 1, "text_item": map[string]string{"text": "你好"}},
					},
				},
			},
			"get_updates_buf": "buf_cursor_2",
		})
	})

	// 4. Mock sendmessage endpoint
	var sentText string
	mux.HandleFunc("POST /ilink/bot/sendmessage", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		msgMap := req["msg"].(map[string]any)
		itemList := msgMap["item_list"].([]any)
		textItem := itemList[0].(map[string]any)["text_item"].(map[string]any)
		sentText = textItem["text"].(string)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"ret": 0})
	})

	// 5. Mock sendtyping endpoint
	mux.HandleFunc("POST /ilink/bot/sendtyping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"ret": 0})
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	client := wechatilink.NewClient(wechatilink.Config{
		BaseURL:  server.URL,
		BotToken: "tok_initial",
		BotID:    "bot_wx_1",
	}, nil)

	// Test QR Code fetch
	qr, err := client.GetQRCode(context.Background())
	if err != nil || qr.QRCode != "qr_test_abc" {
		t.Fatalf("GetQRCode failed: %v", err)
	}

	// Test QR Status check
	status, err := client.GetQRCodeStatus(context.Background(), qr.QRCode)
	if err != nil || status.Status != "confirmed" || status.BotToken != "tok_confirmed_999" {
		t.Fatalf("GetQRCodeStatus failed: %v", err)
	}

	// Test GetUpdates long polling
	updates, err := client.GetUpdates(context.Background(), "")
	if err != nil || len(updates.Msgs) != 1 || updates.GetUpdatesBuf != "buf_cursor_2" {
		t.Fatalf("GetUpdates failed: %v", err)
	}

	// Test SendMessage
	if err := client.SendMessage(context.Background(), "wx_alice", "ctx_123", "收到！"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}
	if sentText != "收到！" {
		t.Fatalf("sentText mismatch: %s", sentText)
	}

	// Test SendTyping
	if err := client.SendTyping(context.Background(), "wx_alice", "ctx_123"); err != nil {
		t.Fatalf("SendTyping failed: %v", err)
	}
}

func TestWeChatILinkServiceProcessing(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "test.sqlite"))
	if err != nil {
		t.Fatalf("failed to open store: %v", err)
	}
	defer store.Close()

	convSvc := chat.NewConversation(store, provider.Offline())
	defer convSvc.Close()

	svc := &wechatilink.Service{
		Store:        store,
		Conversation: convSvc,
	}

	cfg := wechatilink.Config{
		Enabled:      true,
		AllowedUsers: []string{"wx_alice"},
	}

	// 1. Rejected user
	reply, err := svc.ProcessMessage(context.Background(), cfg, "wx_bob", "ctx_1", "你好")
	if err != nil || !strings.Contains(reply, "未在授权白名单内") {
		t.Fatalf("expected unauthorized response, got: %s (err: %v)", reply, err)
	}

	// 2. Allowed user
	reply, err = svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "你好")
	if err != nil || reply == "" {
		t.Fatalf("expected successful reply, got empty or err: %v", err)
	}

	// 3. An approval request shows what it would do; a bare reply answers it
	reply, err = svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "/remember 喜欢喝茶")
	if err != nil || !strings.Contains(reply, "【操作审批】remember\nfact: 喜欢喝茶") || !strings.Contains(reply, "允许请回复「批准」") {
		t.Fatalf("approval request: %s (err: %v)", reply, err)
	}
	if reply, err = svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "批准"); err != nil || !strings.Contains(reply, "已批准") {
		t.Fatalf("bare approval: %s (err: %v)", reply, err)
	}
	if reply, err = svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "拒绝"); err != nil || !strings.Contains(reply, "当前没有待审批的请求") {
		t.Fatalf("nothing pending: %s (err: %v)", reply, err)
	}
	svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "/remember 喜欢咖啡")
	// The demo model echoes the denial and its reason.
	if reply, err = svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "拒绝 我不喝咖啡"); err != nil || !strings.Contains(reply, "已拒绝") || !strings.Contains(reply, "said: 我不喝咖啡") {
		t.Fatalf("denial with a reason: %s (err: %v)", reply, err)
	}
	svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "/remember 散步")
	if reply, err = svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "批准 总是"); err != nil || !strings.Contains(reply, "已记住这个决定") {
		t.Fatalf("remembered approval: %s (err: %v)", reply, err)
	}
	if reply, err = svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "/remember 跑步"); err != nil || strings.Contains(reply, "【操作审批】") {
		t.Fatalf("a remembered approval still asked: %s (err: %v)", reply, err)
	}
	// Only the owner, the first allowed user, can remember approvals.
	guest := wechatilink.Config{Enabled: true, AllowedUsers: []string{"wx_alice", "wx_carol"}}
	svc.ProcessMessage(context.Background(), guest, "wx_carol", "ctx_2", "/remember 我是访客")
	if reply, err = svc.ProcessMessage(context.Background(), guest, "wx_carol", "ctx_2", "批准 总是"); err != nil || !strings.Contains(reply, "only the owner") {
		t.Fatalf("a guest remembered an approval: %s (err: %v)", reply, err)
	}

	// 4. Approval command handling
	approvalReply, err := svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx_1", "批准 12345678901234567890123456789012")
	if err != nil || !strings.Contains(approvalReply, "审批指令无效或该审批已过期") {
		t.Fatalf("expected stale approval response, got: %s (err: %v)", approvalReply, err)
	}
}

// rememberer asks to remember a new fact whenever the user, or a note about a
// decision, speaks last.
type rememberer struct{ facts int }

func (m *rememberer) Ref() llm.Ref   { return llm.Ref{Provider: "test", Model: "rememberer"} }
func (m *rememberer) Info() llm.Info { return llm.Info{ID: "rememberer", Tools: true, Context: 100000} }
func (m *rememberer) Stream(_ context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	if req.Messages[len(req.Messages)-1].Role != "user" {
		return llm.Result{Text: "ok"}, emit("text", "ok")
	}
	m.facts++
	args, _ := json.Marshal(map[string]string{"fact": fmt.Sprintf("fact-%d", m.facts)})
	return llm.Result{Calls: []llm.ToolCall{{ID: chat.NewID(), Name: "remember", Arguments: string(args)}}}, nil
}

type oneModel struct{ model llm.Model }

func (o oneModel) Default() string                          { return "test/rememberer" }
func (o oneModel) Resolve(string) (llm.Model, error)        { return o.model, nil }
func (o oneModel) SetDefault(string) (llm.Ref, error)       { return o.model.Ref(), nil }
func (o oneModel) List(context.Context, string) []llm.Group { return nil }

func TestDecisionShowsTheNextApproval(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "test.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	conversation := chat.NewConversation(store, oneModel{&rememberer{}})
	defer conversation.Close()
	svc := &wechatilink.Service{Store: store, Conversation: conversation}
	cfg := wechatilink.Config{Enabled: true, AllowedUsers: []string{"wx_alice"}}
	if reply, err := svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx", "记点东西"); err != nil || !strings.Contains(reply, "fact: fact-1") {
		t.Fatalf("first request: %s (err: %v)", reply, err)
	}
	for _, c := range []struct{ decision, next string }{{"批准", "fact-2"}, {"拒绝 换一个", "fact-3"}} {
		decision, next := c.decision, c.next
		reply, err := svc.ProcessMessage(context.Background(), cfg, "wx_alice", "ctx", decision)
		if err != nil || !strings.Contains(reply, "【操作审批】remember\nfact: "+next) || !strings.Contains(reply, "允许请回复「批准」") {
			t.Fatalf("%s did not show the next request: %s (err: %v)", decision, reply, err)
		}
	}
}
