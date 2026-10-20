package chat

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

func TestConversationUsage(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	record := func(conversation, message, model string, u llm.Usage) {
		t.Helper()
		if err := s.RecordUsage(conversation, message, model, u, time.Second); err != nil {
			t.Fatal(err)
		}
	}
	record("a", "m1", "openai/small", llm.Usage{Input: 100, Output: 10, Cost: 0.01})
	record("a", "m1", "anthropic/big", llm.Usage{Input: 1000, Output: 200, Reasoning: 50, CacheRead: 600, CacheWrite: 100, Cost: 0.2})
	record("a", "m2", "anthropic/big", llm.Usage{Input: 2000, Output: 100, CacheRead: 1800, Cost: 0.1})
	// A cost the agent reported apart from tokens is no request.
	record("a", "m2", "anthropic/big", llm.Usage{Cost: 0.05})
	record("b", "m3", "openai/small", llm.Usage{Input: 5, Output: 5})
	got, err := s.ConversationUsage("a", "none")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("summaries for %v", got)
	}
	a := got["a"]
	if a.Total != 3410 || a.Input != 3100 || a.CacheRead != 2400 || a.CacheWrite != 100 || a.Reasoning != 50 || a.Turns != 2 || a.Requests != 3 || a.Duration != 4000 || fmt.Sprintf("%.2f", a.Cost) != "0.36" {
		t.Fatalf("summary %+v", a)
	}
	if len(a.Models) != 2 || a.Models[0].Model != "anthropic/big" || a.Models[0].Total != 3300 || a.Models[0].Requests != 2 || a.Models[1].Model != "openai/small" {
		t.Fatalf("models %+v", a.Models)
	}
	raw, _ := json.Marshal(a)
	for _, want := range []string{`"totalTokens":3410`, `"cacheReadTokens":2400`, `"turns":2`, `"models":[{"model":"anthropic/big","totalTokens":3300`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("JSON %s lacks %s", raw, want)
		}
	}
	if brief := a.Brief(); brief != "3.4k tokens (77% cached) · $0.36" {
		t.Fatalf("brief %q", brief)
	}
	if table := a.Markdown(); !strings.Contains(table, "| `anthropic/big` | 3.0k | 2.4k | 100 | 300 | 50 | 2 | $0.3500 |") || !strings.Contains(table, "**All**") || !strings.Contains(table, "over 2 replies; models worked 4s") {
		t.Fatalf("table %s", table)
	}
}

// Replies saved before usage was recorded on its own count from their
// saved usage.
func TestUsageMigrationCountsSavedReplies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mob.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	i := 0
	for ; !strings.Contains(history.steps[i].SQL, "CREATE TABLE IF NOT EXISTS usage("); i++ {
		exec(t, db, history.steps[i].SQL)
	}
	exec(t, db, fmt.Sprintf(`PRAGMA user_version=%d;
INSERT INTO conversations(id,title,updated_at) VALUES('c','old',1);
INSERT INTO messages(id,conversation_id,role,parts,status,model,usage) VALUES('m','c','assistant','[]','complete','openai/gpt','{"inputTokens":120,"outputTokens":30,"cacheReadTokens":100,"cost":0.5}');
INSERT INTO messages(id,conversation_id,role,parts,status) VALUES('u','c','user','[]','complete');`, history.first+i))
	db.Close()
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.ConversationUsage("c")
	if err != nil {
		t.Fatal(err)
	}
	c := got["c"]
	if c.Input != 120 || c.Output != 30 || c.CacheRead != 100 || c.Cost != 0.5 || c.Turns != 1 || len(c.Models) != 1 || c.Models[0].Model != "openai/gpt" {
		t.Fatalf("migrated %+v", c)
	}
}

func TestReport(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _ := s.Create()
	task := Task{Project: "p", Agent: "codex", Title: "fix", Worktree: "/w", Branch: "b", Status: TaskReview}
	if err := s.CreateTask(&task); err != nil {
		t.Fatal(err)
	}
	old := time.Now().AddDate(0, 0, -10).UnixMilli()
	if _, err := s.db.Exec("INSERT INTO usage(conversation_id,message_id,model,input,output,reasoning,cache_read,cache_write,cost,duration_ms,created_at) VALUES(?,'old','a/x',1000,0,0,0,0,1,0,?)", c.ID, old); err != nil {
		t.Fatal(err)
	}
	_ = s.RecordUsage(c.ID, "m1", "a/x", llm.Usage{Input: 100, Output: 10, CacheRead: 50}, time.Second)
	_ = s.RecordUsage(task.ConversationID, "m2", "gpt", llm.Usage{Input: 300, Output: 30}, time.Second)
	all, err := s.Report(time.Time{}, 20)
	if err != nil {
		t.Fatal(err)
	}
	today := time.Now().Format(time.DateOnly)
	if all.Total != 1440 || all.Conversations != 2 || all.Turns != 3 || len(all.Days) != 2 || all.Since != 0 || all.FirstDay != time.UnixMilli(old).Format(time.DateOnly) || all.LastDay != today {
		t.Fatalf("all time %+v", all)
	}
	week, err := s.Report(time.Now().AddDate(0, 0, -7), 1)
	if err != nil {
		t.Fatal(err)
	}
	if week.FirstDay != time.Now().AddDate(0, 0, -7).Format(time.DateOnly) || week.LastDay != today {
		t.Fatalf("week spans %s to %s", week.FirstDay, week.LastDay)
	}
	if week.Total != 440 || len(week.Days) != 1 || week.Days[0].Total != 440 || len(week.Models) != 2 || week.Models[0].Model != "gpt" {
		t.Fatalf("week %+v", week)
	}
	if len(week.Top) != 1 || week.Top[0].ID != task.ConversationID || week.Top[0].Agent != "codex" || week.Top[0].Title != "codex: fix" || week.Top[0].Turns != 1 {
		t.Fatalf("top %+v", week.Top)
	}
	raw, _ := json.Marshal(week)
	if !strings.Contains(string(raw), `"days":[{"date":"`) || !strings.Contains(string(raw), `"top":[{"id":"`) {
		t.Fatalf("JSON %s", raw)
	}
}
