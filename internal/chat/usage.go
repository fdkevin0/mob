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

// RecordUsage adds what one model request used to the reply messageID of
// conversationID.
func (s *Store) RecordUsage(conversationID, messageID, model string, u llm.Usage, took time.Duration) error {
	return s.RecordSessionUsage(conversationID, messageID, "", model, u, took)
}

// RecordSessionUsage adds what one turn of an outside agent's session used
// to the reply messageID of conversationID. model names the model, or the
// agent when it did not say which.
func (s *Store) RecordSessionUsage(conversationID, messageID, session, model string, u llm.Usage, took time.Duration) error {
	_, err := s.db.Exec("INSERT INTO usage(conversation_id,message_id,session,model,input,output,reasoning,cache_read,cache_write,cost,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
		conversationID, messageID, session, model, u.Input, u.Output, u.Reasoning, u.CacheRead, u.CacheWrite, u.Cost, took.Milliseconds(), time.Now().UnixMilli())
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

// SessionTotal sums what conversationID recorded for an outside agent's
// session, for agents that report what a session used so far rather than
// what a turn used.
func (s *Store) SessionTotal(conversationID, session string) (llm.Usage, error) {
	var u llm.Usage
	err := s.db.QueryRow("SELECT COALESCE(SUM(input),0),COALESCE(SUM(output),0),COALESCE(SUM(reasoning),0),COALESCE(SUM(cache_read),0),COALESCE(SUM(cache_write),0),COALESCE(SUM(cost),0) FROM usage WHERE conversation_id=? AND session=?",
		conversationID, session).Scan(&u.Input, &u.Output, &u.Reasoning, &u.CacheRead, &u.CacheWrite, &u.Cost)
	return u, err
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

// UsageReport is what every conversation used since a time: in all, by
// model, by day and by conversation.
type UsageReport struct {
	// Since is the report's start in Unix milliseconds; 0 covers everything.
	Since int64 `json:"since"`
	// FirstDay and LastDay are the local calendar days (YYYY-MM-DD) the
	// report spans on the service's clock: from Since, or the first day that
	// used any, to today.
	FirstDay string `json:"firstDay"`
	LastDay  string `json:"lastDay"`
	UsageSummary
	// Conversations counts the conversations that used any.
	Conversations int `json:"conversations"`
	// Days are the local calendar days that used any, oldest first.
	Days []DayUsage `json:"days"`
	// Top are the conversations that used the most tokens, most first.
	Top []TopConversation `json:"top"`
}

// DayUsage is what one local calendar day (YYYY-MM-DD) used.
type DayUsage struct {
	Date string `json:"date"`
	Usage
}

// TopConversation is what one conversation used, with the coding agent
// that answers it when it is a task.
type TopConversation struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Agent string `json:"agent,omitempty"`
	Usage
	Turns int `json:"turns"`
}

// usageColumns sum a group of usage rows, in Usage's order after Total.
const usageColumns = "SUM(input),SUM(output),SUM(reasoning),SUM(cache_read),SUM(cache_write),SUM(cost),SUM(duration_ms),SUM(input+output>0)"

func scanUsage(u *Usage, dest ...any) []any {
	return append(dest, &u.Input, &u.Output, &u.Reasoning, &u.CacheRead, &u.CacheWrite, &u.Cost, &u.Duration, &u.Requests)
}

// Report sums the usage recorded since since, or all of it when since is
// zero, keeping the top conversations that used the most.
func (s *Store) Report(since time.Time, top int) (UsageReport, error) {
	report := UsageReport{Days: []DayUsage{}, Top: []TopConversation{}}
	from := int64(0)
	report.LastDay = time.Now().Format(time.DateOnly)
	report.FirstDay = report.LastDay
	if !since.IsZero() {
		from = since.UnixMilli()
		report.Since = from
		report.FirstDay = since.Local().Format(time.DateOnly)
	}
	report.Models = []ModelUsage{}
	err := s.db.QueryRow("SELECT COUNT(DISTINCT message_id),COUNT(DISTINCT conversation_id) FROM usage WHERE created_at>=?", from).Scan(&report.Turns, &report.Conversations)
	if err != nil {
		return report, err
	}
	err = s.each("SELECT model,"+usageColumns+" FROM usage WHERE created_at>=? GROUP BY model", []any{from}, func(scan func(...any) error) error {
		var m ModelUsage
		if err := scan(scanUsage(&m.Usage, &m.Model)...); err != nil {
			return err
		}
		m.Total = m.Input + m.Output
		report.Usage = report.Usage.add(m.Usage)
		report.Models = append(report.Models, m)
		return nil
	})
	if err != nil {
		return report, err
	}
	slices.SortStableFunc(report.Models, func(a, b ModelUsage) int { return b.Total - a.Total })
	err = s.each("SELECT date(created_at/1000,'unixepoch','localtime') AS day,"+usageColumns+" FROM usage WHERE created_at>=? GROUP BY day ORDER BY day", []any{from}, func(scan func(...any) error) error {
		var d DayUsage
		if err := scan(scanUsage(&d.Usage, &d.Date)...); err != nil {
			return err
		}
		d.Total = d.Input + d.Output
		report.Days = append(report.Days, d)
		return nil
	})
	if err != nil {
		return report, err
	}
	if since.IsZero() && len(report.Days) > 0 && report.Days[0].Date < report.FirstDay {
		report.FirstDay = report.Days[0].Date
	}
	err = s.each(`SELECT u.conversation_id,COALESCE(c.title,''),COALESCE(t.agent,''),`+usageColumns+`,COUNT(DISTINCT u.message_id) FROM usage u
 LEFT JOIN conversations c ON c.id=u.conversation_id LEFT JOIN tasks t ON t.conversation_id=u.conversation_id
 WHERE u.created_at>=? GROUP BY u.conversation_id ORDER BY SUM(u.input+u.output) DESC LIMIT ?`, []any{from, top}, func(scan func(...any) error) error {
		var c TopConversation
		if err := scan(append(scanUsage(&c.Usage, &c.ID, &c.Title, &c.Agent), &c.Turns)...); err != nil {
			return err
		}
		c.Total = c.Input + c.Output
		report.Top = append(report.Top, c)
		return nil
	})
	return report, err
}

// each runs query and calls row for each row it returns.
func (s *Store) each(query string, args []any, row func(scan func(...any) error) error) error {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := row(rows.Scan); err != nil {
			return err
		}
	}
	return rows.Err()
}
