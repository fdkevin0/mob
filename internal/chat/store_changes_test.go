package chat

import (
	"path/filepath"
	"testing"
)

func TestChangesReachSubscribersAndDropSlowOnes(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	changes, stop := s.Changes.Subscribe()
	c, _ := s.Create()
	if got := <-changes; got.Conversation != c.ID || !got.List {
		t.Fatalf("create: %+v", got)
	}
	m, err := s.Begin(c.ID, "request", "hello", "demo/echo")
	if err != nil {
		t.Fatal(err)
	}
	if got := <-changes; got.Conversation != c.ID || !got.List {
		t.Fatalf("begin: %+v", got)
	}
	m.Parts = []Part{{"type": "text", "text": "hi"}}
	if err := s.Save(m, "complete", ""); err != nil {
		t.Fatal(err)
	}
	if got := <-changes; got.Conversation != c.ID || got.List {
		t.Fatalf("save: %+v", got)
	}
	// A subscriber that stops reading is dropped rather than blocking writes.
	for range changeBuffer + 1 {
		s.Changes.tasks()
	}
	count := 0
	for range changes {
		count++
	}
	if count != changeBuffer {
		t.Fatalf("a slow subscriber got %d changes before being dropped", count)
	}
	stop()
	if s.Changes.watched() {
		t.Fatal("a dropped subscriber still counts")
	}
}
