package chat

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

// Usage is what a set of model requests used. Input counts every prompt
// token, cached or not, as llm.Usage does, and Total is Input and Output.
type Usage struct {
	Total      int     `json:"totalTokens"`
	Input      int     `json:"inputTokens"`
	Output     int     `json:"outputTokens"`
	Reasoning  int     `json:"reasoningTokens"`
	CacheRead  int     `json:"cacheReadTokens"`
	CacheWrite int     `json:"cacheWriteTokens"`
	Cost       float64 `json:"cost"`
	// Duration is how long the models worked, in milliseconds.
	Duration int64 `json:"durationMs"`
	// Requests counts the model requests, or agent turns, that reported tokens.
	Requests int `json:"requests"`
}

// ModelUsage is one model's share of a summary.
type ModelUsage struct {
	Model string `json:"model"`
	Usage
}

// UsageSummary is what a conversation's turns used, in all and by model.
type UsageSummary struct {
	Usage
	// Turns counts the replies that used any.
	Turns int `json:"turns"`
	// Models are sorted by tokens, most first.
	Models []ModelUsage `json:"models"`
}

// RecordUsage adds what one model request, or one turn of an outside agent,
// used to the reply messageID of conversationID. model names the model, or
// the agent when it did not say which.
func (s *Store) RecordUsage(conversationID, messageID, model string, u llm.Usage, took time.Duration) error {
	_, err := s.db.Exec("INSERT INTO usage(conversation_id,message_id,model,input,output,reasoning,cache_read,cache_write,cost,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
		conversationID, messageID, model, u.Input, u.Output, u.Reasoning, u.CacheRead, u.CacheWrite, u.Cost, took.Milliseconds(), time.Now().UnixMilli())
	return err
}

// ConversationUsage sums what each of the conversations ids used.
// Conversations that recorded none are left out.
func (s *Store) ConversationUsage(ids ...string) (map[string]UsageSummary, error) {
	result := map[string]UsageSummary{}
	if len(ids) == 0 {
		return result, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	in := "(" + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + ")"
	rows, err := s.db.Query(`SELECT conversation_id,model,SUM(input),SUM(output),SUM(reasoning),SUM(cache_read),SUM(cache_write),SUM(cost),SUM(duration_ms),
 SUM(input+output>0) FROM usage WHERE conversation_id IN `+in+` GROUP BY conversation_id,model`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var m ModelUsage
		if err := rows.Scan(&id, &m.Model, &m.Input, &m.Output, &m.Reasoning, &m.CacheRead, &m.CacheWrite, &m.Cost, &m.Duration, &m.Requests); err != nil {
			return nil, err
		}
		m.Total = m.Input + m.Output
		summary := result[id]
		summary.Usage = summary.Usage.add(m.Usage)
		summary.Models = append(summary.Models, m)
		result[id] = summary
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// A reply may use several models, so turns are counted apart.
	counts, err := s.db.Query("SELECT conversation_id,COUNT(DISTINCT message_id) FROM usage WHERE conversation_id IN "+in+" GROUP BY conversation_id", args...)
	if err != nil {
		return nil, err
	}
	defer counts.Close()
	for counts.Next() {
		var id string
		var n int
		if err := counts.Scan(&id, &n); err != nil {
			return nil, err
		}
		summary := result[id]
		summary.Turns = n
		slices.SortStableFunc(summary.Models, func(a, b ModelUsage) int { return b.Total - a.Total })
		result[id] = summary
	}
	return result, counts.Err()
}

// ModelTotals sums what conversationID recorded by model, for agents that
// report what a session used so far rather than what a turn used.
func (s *Store) ModelTotals(conversationID string) (map[string]llm.Usage, error) {
	summary, err := s.ConversationUsage(conversationID)
	if err != nil {
		return nil, err
	}
	totals := map[string]llm.Usage{}
	for _, m := range summary[conversationID].Models {
		totals[m.Model] = llm.Usage{Input: m.Input, Output: m.Output, Reasoning: m.Reasoning, CacheRead: m.CacheRead, CacheWrite: m.CacheWrite, Cost: m.Cost}
	}
	return totals, nil
}

func (u Usage) add(v Usage) Usage {
	u.Total += v.Total
	u.Input += v.Input
	u.Output += v.Output
	u.Reasoning += v.Reasoning
	u.CacheRead += v.CacheRead
	u.CacheWrite += v.CacheWrite
	u.Cost += v.Cost
	u.Duration += v.Duration
	u.Requests += v.Requests
	return u
}

// Tokens writes n briefly, as 950, 12.3k or 1.24M.
func Tokens(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.2fM", float64(n)/1e6)
	case n >= 10_000:
		return fmt.Sprintf("%.0fk", float64(n)/1e3)
	case n >= 1000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	}
	return fmt.Sprint(n)
}

// Brief is a summary in one line: tokens, cache reads and cost.
func (s UsageSummary) Brief() string {
	line := Tokens(s.Total) + " tokens"
	if s.CacheRead > 0 && s.Input > 0 {
		line += fmt.Sprintf(" (%d%% cached)", s.CacheRead*100/s.Input)
	}
	if s.Cost > 0 {
		line += fmt.Sprintf(" · $%.2f", s.Cost)
	}
	return line
}

// Markdown shows a summary as a table, with a row for each model.
func (s UsageSummary) Markdown() string {
	var b strings.Builder
	b.WriteString("| Model | Input | Cache read | Cache write | Output | Reasoning | Requests | Cost |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n")
	row := func(name string, u Usage) {
		cost := "—"
		if u.Cost > 0 {
			cost = fmt.Sprintf("$%.4f", u.Cost)
		}
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %s | %s | %d | %s |\n", name, Tokens(u.Input), Tokens(u.CacheRead), Tokens(u.CacheWrite), Tokens(u.Output), Tokens(u.Reasoning), u.Requests, cost)
	}
	for _, m := range s.Models {
		row("`"+Cell(m.Model)+"`", m.Usage)
	}
	if len(s.Models) > 1 {
		row("**All**", s.Usage)
	}
	fmt.Fprintf(&b, "\n%s over %d replies", s.Brief(), s.Turns)
	if s.Duration > 0 {
		fmt.Fprintf(&b, "; models worked %s", (time.Duration(s.Duration) * time.Millisecond).Round(time.Second))
	}
	b.WriteString(". Input counts cached tokens; output counts reasoning.")
	return b.String()
}
