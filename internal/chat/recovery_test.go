package chat

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm/demo"
)

func TestInterruptedApprovalRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.sqlite")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	c, _ := s.Create()
	var approvals []string
	for _, state := range []string{"unfinished", "complete", "pending"} {
		m, err := s.Begin(c.ID, state, "/remember "+state, "demo/echo")
		if err != nil {
			t.Fatal(err)
		}
		var approval string
		err = Run(context.Background(), s, demo.Model{}, Agent{Tools: DefaultTools()}, c.ID, m, "", func(e Event) error {
			if e.Kind == ApprovalRequested {
				approval = e.ApprovalID
			}
			return nil
		})
		if err != nil || approval == "" {
			t.Fatal(err, approval)
		}
		approvals = append(approvals, approval)
		if state == "pending" {
			continue
		}
		d, err := s.Decide(c.ID, approval, true, "")
		if err != nil {
			t.Fatal(err)
		}
		if state == "complete" {
			if err := s.Complete(d, "done", "", nil); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.Summarize(c.ID, Summary{Text: "old approval state", Through: m.ID}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.History(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	var states []string
	for _, m := range h {
		for _, p := range m.Parts {
			if state, ok := p["state"].(string); ok {
				states = append(states, state)
				if state == "output-error" && !strings.Contains(p["errorText"].(string), "outcome is unknown") {
					t.Fatalf("missing warning: %v", p)
				}
			}
		}
	}
	if strings.Join(states, ",") != "output-error,output-available,approval-requested" {
		t.Fatalf("recovered states: %v", states)
	}
	if _, err := s.Decide(c.ID, approvals[0], true, ""); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("recovered action can run again: %v", err)
	}
	sum, err := s.Summary(c.ID)
	if err != nil || sum.Text != "" {
		t.Fatalf("stale summary retained: %+v %v", sum, err)
	}
}
