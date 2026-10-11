package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPersistenceApprovalAndRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.sqlite")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s != nil {
			s.Close()
		}
	})
	if other, err := OpenStore(path); err == nil {
		other.Close()
		t.Fatal("second process acquired live database")
	}
	c, err := s.Create()
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.Begin(c.ID, "request-1", "/remember 喜欢中文")
	if err != nil {
		t.Fatal(err)
	}
	var events []Event
	err = Run(context.Background(), s, Provider{Demo: true}, c.ID, m, "", func(e Event) error { events = append(events, e); return nil })
	if err != nil {
		t.Fatal(err)
	}
	var approval string
	for _, e := range events {
		if e.Kind == ApprovalRequested {
			approval = e.ApprovalID
		}
	}
	if approval == "" {
		t.Fatal("missing approval event")
	}
	if facts, _ := s.Memories(c.ID); len(facts) != 0 {
		t.Fatal("executed without approval")
	}
	if _, err = s.Decide(NewID(), approval, true); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("cross-conversation approval: %v", err)
	}
	if _, err = s.Decide(c.ID, approval, true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Decide(c.ID, approval, true); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("repeated approval: %v", err)
	}
	facts, err := s.Memories(c.ID)
	if err != nil || len(facts) != 1 || facts[0] != "喜欢中文" {
		t.Fatalf("facts %v, %v", facts, err)
	}
	if _, err = s.Begin(c.ID, "request-1", "duplicate"); err == nil {
		t.Fatal("duplicate request accepted")
	}
	history, err := s.History(c.ID)
	if err != nil || len(history) != 2 {
		t.Fatalf("history: %v %v", history, err)
	}
	if history[1].Parts[0]["state"] != "output-available" {
		t.Fatal("approval UI state not persisted")
	}
	m, err = s.Begin(c.ID, "interrupted", "hello")
	if err != nil {
		t.Fatal(err)
	}
	m.Parts = []Part{{"type": "text", "text": "partial"}}
	if err = s.Save(m, "streaming", ""); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s = nil
	s, err = OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	history, err = s.History(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := history[len(history)-1]
	if Text(last) != "partial" || last.Metadata["status"] != "interrupted" {
		t.Fatalf("recovery lost state: %+v", last)
	}
}

func TestDenialAndExpiry(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	for _, action := range []string{"deny", "expire"} {
		m, err := s.Begin(c.ID, NewID(), "remember")
		if err != nil {
			t.Fatal(err)
		}
		m.Parts = []Part{{"type": "tool-remember", "toolCallId": "call", "input": map[string]string{"fact": "test"}}}
		id, err := s.RequestApproval(c.ID, m, "call", map[string]string{"fact": "test"})
		if err != nil {
			t.Fatal(err)
		}
		if action == "expire" {
			if _, err = s.db.Exec("UPDATE approvals SET expires_at=0 WHERE id=?", id); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Decide(c.ID, id, true); !errors.Is(err, ErrStaleApproval) {
				t.Fatal(err)
			}
		} else {
			if _, err = s.Decide(c.ID, id, false); err != nil {
				t.Fatal(err)
			}
		}
	}
	facts, err := s.Memories(c.ID)
	if err != nil || len(facts) != 0 {
		t.Fatalf("denied/expired wrote facts: %v %v", facts, err)
	}
}

func TestProviderStreamingAndTruncation(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		t.Run(fmt.Sprint(truncated), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer test" {
					t.Error("bad provider request")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考\"}}]}\r\n\r\n")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"你好\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"datetime\",\"arguments\":\"{\"}}]}}]}\n\n")
				if !truncated {
					fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\n")
					fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3}}\n\ndata: [DONE]\n\n")
				}
			}))
			defer upstream.Close()
			var got string
			result, err := (Provider{BaseURL: upstream.URL, APIKey: "test", Model: "test"}).Stream(context.Background(), []ModelMessage{{Role: "user", Content: "hi"}}, func(kind, delta string) error { got += kind + ":" + delta + ";"; return nil })
			if truncated {
				if err == nil {
					t.Fatal("truncated stream marked successful")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != "reasoning:思考;text:你好;" || len(result.Calls) != 1 || result.Calls[0].ID != "c1" || result.Calls[0].Function.Arguments != "{}" || result.Usage["prompt_tokens"] != float64(3) {
				t.Fatalf("bad result: %+v %s", result, got)
			}
		})
	}
}

func TestSSEMultiline(t *testing.T) {
	var got []string
	err := ReadSSE(strings.NewReader(": heartbeat\r\ndata: one\r\ndata: two\r\n\r\ndata: tail"), func(raw []byte) error { got = append(got, string(raw)); return nil })
	if err != nil || strings.Join(got, "|") != "one\ntwo|tail" {
		t.Fatalf("%v %v", got, err)
	}
}

func TestEngineContinuesAfterTool(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []ModelMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"clock","function":{"name":"datetime","arguments":"{\"timezone\":\"Asia/Shanghai\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\n")
		} else {
			last := body.Messages[len(body.Messages)-1]
			if last.Role != "tool" || last.ToolCallID != "clock" || !strings.Contains(last.Content, "Asia/Shanghai") {
				t.Errorf("missing tool result: %+v", last)
			}
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"Time checked."},"finish_reason":"stop"}]}`+"\n\n")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	m, err := s.Begin(c.ID, NewID(), "What time is it?")
	if err != nil {
		t.Fatal(err)
	}
	err = Run(context.Background(), s, Provider{BaseURL: upstream.URL, APIKey: "test", Model: "test"}, c.ID, m, "", func(Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	history, err := s.History(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := history[len(history)-1]
	if calls.Load() != 2 || last.Parts[0]["state"] != "output-available" || Text(last) != "Time checked." {
		t.Fatalf("bad tool continuation: %+v", last)
	}
}
