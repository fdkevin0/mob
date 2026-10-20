package agents

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	acp "github.com/coder/acp-go-sdk"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
)

// What agents used is recorded when each prompt ends, from what the prompt's
// response says it used, or, for agents whose responses do not say, from
// what the agent's own records say its session used so far.

// modelOption is the model a session's options select, if they name one.
func modelOption(options []acp.SessionConfigOption) string {
	for _, o := range options {
		if o.Select != nil && o.Select.Category != nil && *o.Select.Category == acp.SessionConfigOptionCategoryModel {
			return string(o.Select.CurrentValue)
		}
	}
	return ""
}

// costed adds the session cost an agent reported, which grows over the
// agent's run, to what the next prompt's end records.
func (s *session) costed(u *acp.SessionUsageUpdate) {
	if u.Cost == nil || u.Cost.Currency != "USD" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A smaller total is a new run's.
	if spent := u.Cost.Amount - s.cost; spent > 0 {
		s.unpriced += spent
	} else if spent < 0 {
		s.unpriced += u.Cost.Amount
	}
	s.cost = u.Cost.Amount
}

// used records what the prompt that ended with e used.
func (s *session) used(turn *chat.DelegateTurn, e ending) error {
	s.mu.Lock()
	model, cost := s.model, s.unpriced
	s.unpriced = 0
	s.mu.Unlock()
	if model == "" {
		model = s.preset.Name
	}
	took := time.Since(e.began)
	rows := reported(e.usage, e.meta)
	if len(rows) == 0 && s.preset.Tally != nil {
		tallied, u, err := s.preset.Tally(string(s.id))
		if err != nil {
			return err
		}
		if tallied != "" {
			model = tallied
		}
		recorded, err := s.svc.Store.ModelTotals(turn.ConversationID)
		if err != nil {
			return err
		}
		for _, r := range recorded {
			u.Input, u.Output, u.Reasoning, u.CacheRead, u.CacheWrite = u.Input-r.Input, u.Output-r.Output, u.Reasoning-r.Reasoning, u.CacheRead-r.CacheRead, u.CacheWrite-r.CacheWrite
		}
		u.Reasoning, u.CacheRead, u.CacheWrite = max(u.Reasoning, 0), max(u.CacheRead, 0), max(u.CacheWrite, 0)
		if u.Input > 0 || u.Output > 0 {
			rows = []modelUsage{{"", u}}
		}
	}
	if len(rows) == 0 {
		if cost == 0 {
			return nil
		}
		rows = []modelUsage{{}}
	}
	for i, r := range rows {
		if r.model == "" {
			r.model = model
		}
		if i == 0 {
			r.usage.Cost += cost
		} else {
			took = 0
		}
		if err := turn.Used(r.model, r.usage, took); err != nil {
			return err
		}
	}
	return nil
}

type modelUsage struct {
	model string
	usage llm.Usage
}

// reported is what a prompt's response says it used, by model when its
// metadata breaks it down as Claude Agent's does.
func reported(u *acp.Usage, meta map[string]any) []modelUsage {
	if u == nil {
		return nil
	}
	total := normal(u.InputTokens, value(u.CachedReadTokens), value(u.CachedWriteTokens), u.OutputTokens, value(u.ThoughtTokens), u.TotalTokens)
	if total.Input == 0 && total.Output == 0 {
		return nil
	}
	var quota struct {
		Quota struct {
			Models []struct {
				Model  string `json:"model"`
				Tokens struct {
					Input      int `json:"inputTokens"`
					CacheRead  int `json:"cachedInputTokens"`
					CacheWrite int `json:"cachedWriteTokens"`
					Output     int `json:"outputTokens"`
					Reasoning  int `json:"reasoningOutputTokens"`
					Total      int `json:"totalTokens"`
				} `json:"token_count"`
			} `json:"model_usage"`
		} `json:"quota"`
	}
	if raw, err := json.Marshal(meta); err == nil && json.Unmarshal(raw, &quota) == nil && len(quota.Quota.Models) > 0 {
		var rows []modelUsage
		var sum llm.Usage
		for _, m := range quota.Quota.Models {
			t := m.Tokens
			u := normal(t.Input, t.CacheRead, t.CacheWrite, t.Output, t.Reasoning, t.Total)
			rows = append(rows, modelUsage{m.Model, u})
			sum.Input += u.Input
			sum.Output += u.Output
		}
		// The breakdown is used only when it accounts for the whole.
		if sum.Input == total.Input && sum.Output == total.Output {
			return rows
		}
	}
	return []modelUsage{{"", total}}
}

// normal counts input as every prompt token, as llm.Usage does. Agents that
// count input without the cache, as Anthropic does, give a total that adds
// the cache to it.
func normal(input, cacheRead, cacheWrite, output, reasoning, total int) llm.Usage {
	if cacheRead+cacheWrite > 0 && total >= input+cacheRead+cacheWrite+output {
		input += cacheRead + cacheWrite
	}
	return llm.Usage{Input: input, Output: output, Reasoning: reasoning, CacheRead: cacheRead, CacheWrite: cacheWrite}
}

func value(n *int) int {
	if n == nil {
		return 0
	}
	return *n
}

// codexTally reads what Codex recorded its session, a thread of the same ID,
// used so far, and the model it last used, from the thread's rollout file.
func codexTally(session string) (string, llm.Usage, error) {
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		dir, err := os.UserHomeDir()
		if err != nil {
			return "", llm.Usage{}, err
		}
		home = filepath.Join(dir, ".codex")
	}
	matches, _ := filepath.Glob(filepath.Join(home, "sessions", "*", "*", "*", "rollout-*-"+session+".jsonl"))
	if len(matches) == 0 {
		return "", llm.Usage{}, nil
	}
	f, err := os.Open(matches[len(matches)-1])
	if err != nil {
		return "", llm.Usage{}, err
	}
	defer f.Close()
	var model string
	var usage llm.Usage
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		var item struct {
			Type    string `json:"type"`
			Payload struct {
				Type  string `json:"type"`
				Model string `json:"model"`
				Info  *struct {
					Total struct {
						Input      int `json:"input_tokens"`
						CacheRead  int `json:"cached_input_tokens"`
						CacheWrite int `json:"cache_write_input_tokens"`
						Output     int `json:"output_tokens"`
						Reasoning  int `json:"reasoning_output_tokens"`
					} `json:"total_token_usage"`
				} `json:"info"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &item) == nil {
			switch {
			case item.Type == "turn_context" && item.Payload.Model != "":
				model = item.Payload.Model
			case item.Type == "event_msg" && item.Payload.Type == "token_count" && item.Payload.Info != nil:
				t := item.Payload.Info.Total
				usage = llm.Usage{Input: t.Input, Output: t.Output, Reasoning: t.Reasoning, CacheRead: t.CacheRead, CacheWrite: t.CacheWrite}
			}
		}
		if errors.Is(err, io.EOF) {
			return model, usage, nil
		}
		if err != nil {
			return model, usage, err
		}
	}
}
