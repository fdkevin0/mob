package chat

import (
	"path/filepath"
	"testing"
	"time"
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

func TestPendingApprovalsExpireOnTimeAndTellClients(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "chat.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	m, err := s.Begin(c.ID, "request", "run it", "demo/echo")
	if err != nil {
		t.Fatal(err)
	}
	m.Parts = []Part{{"type": "tool-sandbox", "toolCallId": "call", "state": "input-available"}}
	approval, err := s.RequestApproval(c.ID, m, "call", map[string]string{"command": "ls"})
	if err != nil {
		t.Fatal(err)
	}
	// Nothing reads the conversation while the approval waits; only its time passing changes it.
	changes, stop := s.Changes.Subscribe()
	defer stop()
	if _, err := s.db.Exec("UPDATE approvals SET expires_at=? WHERE id=?", time.Now().Add(50*time.Millisecond).UnixMilli(), approval); err != nil {
		t.Fatal(err)
	}
	s.scheduleExpiry(c.ID)
	select {
	case got := <-changes:
		if got.Conversation != c.ID {
			t.Fatalf("expiry published %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the approval did not expire on its own")
	}
	var status string
	if err := s.db.QueryRow("SELECT status FROM approvals WHERE id=?", approval).Scan(&status); err != nil || status != "expired" {
		t.Fatalf("approval status %q, %v", status, err)
	}
}
