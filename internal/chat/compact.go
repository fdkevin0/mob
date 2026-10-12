package chat

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/fdkevin0/mob/internal/llm"
)

const (
	// compactPrompt instructs the model that folds older messages into a
	// conversation's summary.
	compactPrompt = "You keep the summary of a conversation between a user and Mob, an assistant with tools, so that it can go on once older messages are dropped. Fold the new part of the conversation into the summary. Keep the user's goals, requests and preferences, decisions made, facts learned, names, files and paths, tool results that still matter, and unfinished work. Leave out pleasantries and whatever was superseded. Write plain text in the conversation's language."
	// summaryTokens bounds a summary.
	summaryTokens = 4000
	// summaryNotice introduces the summary in a turn's instructions.
	summaryNotice = "\n\nSummary of the earlier conversation, whose messages are no longer shown:\n"
	// transcriptOutput is how much of each tool output a summary reads.
	transcriptOutput = 2000
)

// summarize folds messages into previous with model, as many messages at a
// time as fit its window, in a summary of at most limit tokens, and returns
// the new summary and what it cost.
func summarize(ctx context.Context, model llm.Model, previous string, messages []Message, limit int) (string, *llm.Usage, error) {
	info := model.Info()
	maxTokens := min(summaryTokens, limit)
	if info.Output > 0 {
		maxTokens = min(maxTokens, info.Output)
	}
	// About three words take four tokens.
	system := compactPrompt + fmt.Sprintf(" Use at most about %d words.", maxTokens*3/8)
	var usage *llm.Usage
	summary, part := previous, ""
	flush := func() error {
		if part == "" {
			return nil
		}
		text := "Conversation:\n" + part + "\nWrite the summary."
		if summary != "" {
			text = "Summary so far:\n" + summary + "\n\n" + text
		}
		if info.Context > 0 && tokens(system)+tokens(text)+maxTokens > info.Context {
			return fmt.Errorf("summarizing would exceed %s's context", info.ID)
		}
		result, err := model.Stream(ctx, llm.Request{System: system, Messages: []llm.Message{{Role: "user", Text: text}}, MaxTokens: maxTokens}, func(string, string) error { return nil })
		if result.Usage != nil {
			usage = add(usage, result.Usage.Priced(info.Cost))
		}
		if err != nil {
			return err
		}
		if strings.TrimSpace(result.Text) == "" {
			return errors.New("model wrote an empty summary")
		}
		summary, part = strings.TrimSpace(result.Text), ""
		return nil
	}
	// room is what the conversation part may take beside the instructions,
	// the summary so far and the summary to write.
	room := func() int {
		if info.Context <= 0 {
			return 100000
		}
		return info.Context - maxTokens - tokens(system) - tokens(summary) - 100
	}
	for _, m := range messages {
		text := transcript(m)
		for {
			// The room shrinks as the summary grows, so each message is fitted
			// against the summary it will be read with.
			r := room()
			if r <= 0 {
				return "", usage, fmt.Errorf("%s's context is too small to summarize this conversation", info.ID)
			}
			fitted := text
			if tokens(fitted) > r/2 {
				head, tail := ends(fitted, r, r/2)
				fitted = head + "\n[...]\n" + tail
			}
			if part == "" || tokens(part)+tokens(fitted) <= r {
				part += fitted
				break
			}
			if err := flush(); err != nil {
				return "", usage, err
			}
		}
	}
	if err := flush(); err != nil {
		return "", usage, err
	}
	return summary, usage, nil
}

// transcript is a stored message as a summary reads it: who said what, and
// what tools were called with and returned, their outputs cut short.
func transcript(m Message) string {
	if m.Command {
		return ""
	}
	who := "User"
	if m.Role == "assistant" {
		who = "Mob"
	}
	var b strings.Builder
	for _, part := range m.Parts {
		kind := fmt.Sprint(part["type"])
		switch {
		case kind == "text":
			if text := strings.TrimSpace(fmt.Sprint(part["text"])); text != "" {
				b.WriteString(who + ": " + text + "\n")
			}
		case strings.HasPrefix(kind, "tool-"):
			head, tail := ends(outcome(part), transcriptOutput*2/3, transcriptOutput/3)
			if tail != "" {
				head += " [...] " + tail
			}
			b.WriteString(fmt.Sprintf("Mob called %s with %s; it returned %s\n", kind[5:], encode(part["input"]), head))
		}
	}
	return b.String()
}
