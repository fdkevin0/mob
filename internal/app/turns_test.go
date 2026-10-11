package app

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/protocol"
	"github.com/fdkevin0/mob/internal/provider"
)

type sseEvent struct {
	seq   int
	chunk protocol.Chunk
	done  bool
}

// readSSE reads events until the stream ends or stop returns true.
func readSSE(t *testing.T, body io.Reader, stop func(sseEvent) bool) []sseEvent {
	t.Helper()
	var events []sseEvent
	var seq int
	scanner := bufio.NewScanner(body)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "id: "):
			seq, _ = strconv.Atoi(strings.TrimPrefix(line, "id: "))
			continue
		case line == "data: [DONE]":
			events = append(events, sseEvent{done: true})
		case strings.HasPrefix(line, "data: "):
			e := sseEvent{seq: seq}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &e.chunk); err != nil {
				t.Fatal(err)
			}
			events = append(events, e)
		default:
			continue
		}
		if stop != nil && stop(events[len(events)-1]) {
			break
		}
	}
	return events
}

func text(events []sseEvent) string {
	var b strings.Builder
	for _, e := range events {
		if e.chunk.Type == "text-delta" {
			b.WriteString(e.chunk.Delta)
		}
	}
	return b.String()
}

func TestTurnsOutliveTheirRequest(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	c, _ := store.Create()
	server := NewServer(store, provider.Offline(), strings.Repeat("t", 32))
	defer server.Close()
	httpServer := httptest.NewServer(server.Handler(nil))
	defer httpServer.Close()
	request := func(ctx context.Context, method, path string, body string, header ...string) *http.Response {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, method, httpServer.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+server.Token())
		for i := 0; i+1 < len(header); i += 2 {
			req.Header.Set(header[i], header[i+1])
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	stream := "/api/chat/" + c.ID + "/stream"
	if idle := request(context.Background(), "GET", stream, ""); idle.StatusCode != 204 {
		t.Fatalf("idle conversation streamed: %s", idle.Status)
	}

	// The client that sends the message leaves after the first few events.
	ctx, leave := context.WithCancel(context.Background())
	sent := request(ctx, "POST", "/api/chat", `{"id":"`+c.ID+`","requestId":"once","text":"hello"}`)
	first := readSSE(t, sent.Body, func(e sseEvent) bool { return e.chunk.Type == "text-delta" })
	leave()
	sent.Body.Close()
	if first[0].seq != 1 || first[0].chunk.Type != "start" || first[0].chunk.MessageID == "" {
		t.Fatalf("stream did not start with a numbered start event: %+v", first[0])
	}
	if !server.Active(c.ID) {
		t.Fatal("leaving the stream ended the turn")
	}

	// Another client replays the turn from the start, and a third from where it left off.
	full := request(context.Background(), "GET", stream, "")
	later := request(context.Background(), "GET", stream, "", "Last-Event-ID", "3")
	defer full.Body.Close()
	defer later.Body.Close()
	replayed := readSSE(t, full.Body, nil)
	rest := readSSE(t, later.Body, nil)
	if !replayed[len(replayed)-1].done || !rest[len(rest)-1].done {
		t.Fatal("a resumed stream did not end with [DONE]")
	}
	if replayed[0].chunk.MessageID != first[0].chunk.MessageID || replayed[len(replayed)-2].chunk.Type != "finish" {
		t.Fatalf("replay is not the whole turn: %+v … %+v", replayed[0], replayed[len(replayed)-2])
	}
	if rest[0].seq != 4 || len(rest) != len(replayed)-3 {
		t.Fatalf("Last-Event-ID 3 resumed at %d with %d of %d events", rest[0].seq, len(rest), len(replayed))
	}

	history, err := store.History(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	reply := history[len(history)-1]
	if reply.Metadata["status"] != "complete" || chat.Text(reply) != text(replayed) || !strings.Contains(text(replayed), "Received: hello") {
		t.Fatalf("saved reply %v %q, streamed %q", reply.Metadata["status"], chat.Text(reply), text(replayed))
	}
	if done := request(context.Background(), "GET", stream, ""); done.StatusCode != 204 {
		t.Fatalf("finished turn still streams: %s", done.Status)
	}

	// A replaced token still ends a turn it started after its client left.
	ctx, leave = context.WithCancel(context.Background())
	sent = request(ctx, "POST", "/api/chat", `{"id":"`+c.ID+`","requestId":"twice","text":"hello"}`)
	readSSE(t, sent.Body, func(e sseEvent) bool { return e.chunk.Type == "text-delta" })
	leave()
	sent.Body.Close()
	run := server.Watch(c.ID)
	server.PersistToken = func(string) error { return nil }
	if err := server.rotateToken(func(string) bool { return true }); err != nil {
		t.Fatal(err)
	}
	<-run.Done()
	if history, _ = store.History(c.ID); history[len(history)-1].Metadata["status"] != "cancelled" {
		t.Fatalf("rotation left the turn %v", history[len(history)-1].Metadata["status"])
	}
}
