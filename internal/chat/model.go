package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Provider struct {
	Transport              http.RoundTripper `json:"-"`
	BaseURL, APIKey, Model string
	Demo                   bool
}
type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}
type ModelMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	Reasoning  string     `json:"reasoning_content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}
type ModelResult struct {
	Text, Reasoning string
	Calls           []ToolCall
	Usage           map[string]any
}

// ReadSSE also handles CRLF and multi-line data fields; callers choose how to interpret events.
func ReadSSE(r io.Reader, handle func([]byte) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	var data []string
	flush := func() error {
		if len(data) == 0 {
			return nil
		}
		raw := strings.Join(data, "\n")
		data = nil
		return handle([]byte(raw))
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

func (p Provider) Stream(ctx context.Context, messages []ModelMessage, emit func(kind, delta string) error) (ModelResult, error) {
	return p.stream(ctx, messages, emit, tools)
}
func (p Provider) stream(ctx context.Context, messages []ModelMessage, emit func(kind, delta string) error, toolDefinitions []any) (ModelResult, error) {
	if p.Demo {
		return demoStream(ctx, messages, emit)
	}
	var result ModelResult
	if p.APIKey == "" {
		if p.IsOpenCodeFreeTier() {
			p.APIKey = DefaultOpenCodeZenKey
		} else {
			return result, errors.New("set MOB_API_KEY (or DEEPSEEK_API_KEY), or configure a model provider")
		}
	}
	effectiveTools := toolDefinitions
	if p.IsOpenCodeFreeTier() {
		effectiveTools = EnsureOpenCodeFreeTools(toolDefinitions)
	}
	requestBody := map[string]any{"model": p.Model, "messages": messages, "stream": true, "stream_options": map[string]bool{"include_usage": true}, "max_tokens": 2048}
	if len(effectiveTools) > 0 {
		requestBody["tools"] = effectiveTools
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return result, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(p.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	if p.IsOpenCodeZen() {
		p.ApplyOpenCodeHeaders(req.Header, "")
	}
	client := http.Client{Transport: p.Transport, Timeout: 3 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return result, fmt.Errorf("model connection failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return result, fmt.Errorf("model returned HTTP %d", resp.StatusCode)
	}
	finished := false
	done := false
	size := 0
	err = ReadSSE(resp.Body, func(raw []byte) error {
		if string(raw) == "[DONE]" {
			done = true
			return nil
		}
		if done {
			return errors.New("model sent data after completion")
		}
		var chunk struct {
			Error   json.RawMessage `json:"error"`
			Usage   map[string]any  `json:"usage"`
			Choices []struct {
				Finish *string `json:"finish_reason"`
				Delta  struct {
					Content      string `json:"content"`
					Reasoning    string `json:"reasoning_content"`
					AltReasoning string `json:"reasoning"`
					Calls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(raw, &chunk); err != nil {
			return errors.New("invalid model stream JSON")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return errors.New("model reported a stream error")
		}
		if chunk.Usage != nil {
			result.Usage = chunk.Usage
		}
		if len(chunk.Choices) == 0 {
			return nil
		}
		c := chunk.Choices[0]
		if c.Finish != nil {
			finished = true
		}
		reasoningText := c.Delta.Reasoning
		if reasoningText == "" {
			reasoningText = c.Delta.AltReasoning
		}
		for _, d := range []struct{ kind, text string }{{"reasoning", reasoningText}, {"text", c.Delta.Content}} {
			size += len(d.text)
			if size > 2<<20 {
				return errors.New("model response exceeded limit")
			}
			if d.text == "" {
				continue
			}
			if d.kind == "text" {
				result.Text += d.text
			} else {
				result.Reasoning += d.text
			}
			if err := emit(d.kind, d.text); err != nil {
				return err
			}
		}
		for _, call := range c.Delta.Calls {
			if call.Index < 0 || call.Index >= 16 {
				return errors.New("too many model tool calls")
			}
			for len(result.Calls) <= call.Index {
				result.Calls = append(result.Calls, ToolCall{Type: "function"})
			}
			v := &result.Calls[call.Index]
			v.ID += call.ID
			v.Function.Name += call.Function.Name
			v.Function.Arguments += call.Function.Arguments
			if len(v.Function.Arguments) > 16384 || len(v.ID) > 200 || len(v.Function.Name) > 100 {
				return errors.New("model tool call exceeded limit")
			}
		}
		return nil
	})
	if err == nil && !finished && !done {
		err = errors.New("model stream ended before completion")
	}
	return result, err
}

func demoStream(ctx context.Context, messages []ModelMessage, emit func(string, string) error) (ModelResult, error) {
	last := messages[len(messages)-1]
	if last.Role == "user" && strings.HasPrefix(last.Content, "/remember ") {
		call := ToolCall{ID: NewID(), Type: "function"}
		call.Function.Name = "remember"
		args, _ := json.Marshal(map[string]string{"fact": strings.TrimPrefix(last.Content, "/remember ")})
		call.Function.Arguments = string(args)
		return ModelResult{Calls: []ToolCall{call}}, nil
	}
	text := "[Demo mode — no model request]\n\nReceived: " + last.Content + "\n\nUse /remember a fact to exercise persistent approval."
	var result ModelResult
	for _, r := range text {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(4 * time.Millisecond):
		}
		result.Text += string(r)
		if err := emit("text", string(r)); err != nil {
			return result, err
		}
	}
	return result, nil
}

func (p Provider) Analyze(ctx context.Context, messages []ModelMessage) (ModelResult, error) {
	return p.stream(ctx, messages, func(string, string) error { return nil }, nil)
}
