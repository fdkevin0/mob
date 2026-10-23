package app

import (
	"bufio"
	"encoding/json"
	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/provider"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEventsTellWhatChanged(t *testing.T) {
	s, err := chat.OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server := NewServer(s, provider.Offline(), strings.Repeat("t", 32))
	httpServer := httptest.NewServer(server.Handler(nil))
	defer httpServer.Close()
	req, _ := http.NewRequest("GET", httpServer.URL+"/api/events", nil)
	req.Header.Set("Authorization", "Bearer "+server.Token())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events answered %s %q", resp.Status, resp.Header.Get("Content-Type"))
	}
	lines := make(chan string)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	next := func() chat.Change {
		t.Helper()
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatal("stream ended")
				}
				if data, found := strings.CutPrefix(line, "data: "); found {
					var change chat.Change
					if err := json.Unmarshal([]byte(data), &change); err != nil {
						t.Fatal(err)
					}
					return change
				}
			case <-time.After(5 * time.Second):
				t.Fatal("no change arrived")
			}
		}
	}
	// The stream is subscribed once its first comment arrives.
	if line := <-lines; line != "retry: 2000" {
		t.Fatalf("first line %q", line)
	}
	c, err := s.Create()
	if err != nil {
		t.Fatal(err)
	}
	if change := next(); change.Conversation != c.ID || !change.List || change.Seq == 0 {
		t.Fatalf("create published %+v", change)
	}
	if err := s.SetConversationModel(c.ID, "demo/echo"); err != nil {
		t.Fatal(err)
	}
	if change := next(); change.Conversation != c.ID || change.List {
		t.Fatalf("model change published %+v", change)
	}
	task := chat.Task{Project: "p", Agent: "codex", Title: "t", Status: chat.TaskRunning}
	if err := s.CreateTask(&task); err != nil {
		t.Fatal(err)
	}
	if change := next(); change.Conversation != task.ConversationID || !change.List {
		t.Fatalf("task conversation published %+v", change)
	}
	if change := next(); !change.Tasks {
		t.Fatalf("task published %+v", change)
	}
	// Closing the server ends the stream instead of holding shutdown open.
	server.Close()
	for range lines {
	}
}
