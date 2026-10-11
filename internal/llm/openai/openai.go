// Package openai speaks OpenAI Chat Completions, the protocol most vendors,
// relays and local servers (Ollama, LM Studio, vLLM) answer.
package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/fdkevin0/mob/internal/llm"
)

type Config struct {
	BaseURL, Key string
	Headers      map[string]string
	Transport    http.RoundTripper
	// Prepare adjusts a vendor's request after it is built (provider quirks).
	Prepare func(req *http.Request, body map[string]any)
}

type Model struct {
	ref    llm.Ref
	info   llm.Info
	config Config
}

func New(ref llm.Ref, info llm.Info, c Config) *Model { return &Model{ref, info, c} }
func (m *Model) Ref() llm.Ref                         { return m.ref }
func (m *Model) Info() llm.Info                       { return m.info }

func messages(req llm.Request) []map[string]any {
	out := []map[string]any{}
	if req.System != "" {
		out = append(out, map[string]any{"role": "system", "content": req.System})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case "tool":
			out = append(out, map[string]any{"role": "tool", "tool_call_id": m.ToolCallID, "content": m.Text})
		case "assistant":
			v := map[string]any{"role": "assistant", "content": m.Text}
			if m.Reasoning != "" {
				v["reasoning_content"] = m.Reasoning
			}
			if len(m.ToolCalls) > 0 {
				calls := make([]map[string]any, len(m.ToolCalls))
				for i, c := range m.ToolCalls {
					calls[i] = map[string]any{"id": c.ID, "type": "function", "function": map[string]string{"name": c.Name, "arguments": c.Arguments}}
				}
				v["tool_calls"] = calls
			}
			out = append(out, v)
		default:
			out = append(out, map[string]any{"role": m.Role, "content": m.Text})
		}
	}
	return out
}

func tools(ts []llm.Tool) []map[string]any {
	out := make([]map[string]any, len(ts))
	for i, t := range ts {
		out[i] = map[string]any{"type": "function", "function": map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters}}
	}
	return out
}

func (m *Model) Stream(ctx context.Context, req llm.Request, emit func(kind, delta string) error) (llm.Result, error) {
	var result llm.Result
	body := map[string]any{"model": m.ref.Model, "messages": messages(req), "stream": true, "stream_options": map[string]bool{"include_usage": true}}
	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}
	if len(req.Tools) > 0 {
		body["tools"] = tools(req.Tools)
	}
	if m.ref.Effort != "" {
		body["reasoning_effort"] = m.ref.Effort
	}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(m.config.BaseURL, "/")+"/chat/completions", nil)
	if err != nil {
		return result, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if m.config.Key != "" {
		httpReq.Header.Set("Authorization", "Bearer "+m.config.Key)
	}
	for k, v := range m.config.Headers {
		httpReq.Header.Set(k, v)
	}
	if m.config.Prepare != nil {
		m.config.Prepare(httpReq, body)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return result, err
	}
	httpReq.Body = io.NopCloser(bytes.NewReader(raw))
	httpReq.ContentLength = int64(len(raw))
	resp, err := llm.Send(m.config.Transport, httpReq)
	if err != nil {
		return result, fmt.Errorf("model connection failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return result, StatusError(resp, Secrets(m.config.Key, m.config.Headers)...)
	}
	finished, done, size := false, false, 0
	err = llm.ReadSSE(resp.Body, func(_ string, data []byte) error {
		if string(data) == "[DONE]" {
			done = true
			return nil
		}
		if done {
			return errors.New("model sent data after completion")
		}
		var chunk struct {
			Error   json.RawMessage `json:"error"`
			Usage   *usage          `json:"usage"`
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
		if err := json.Unmarshal(data, &chunk); err != nil {
			return errors.New("invalid model stream JSON")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return errors.New("model reported a stream error")
		}
		if chunk.Usage != nil {
			u := chunk.Usage.normal()
			result.Usage = &u
		}
		if len(chunk.Choices) == 0 {
			return nil
		}
		c := chunk.Choices[0]
		if c.Finish != nil {
			finished = true
		}
		reasoning := c.Delta.Reasoning
		if reasoning == "" {
			reasoning = c.Delta.AltReasoning
		}
		for _, d := range []struct{ kind, text string }{{"reasoning", reasoning}, {"text", c.Delta.Content}} {
			size += len(d.text)
			if size > llm.MaxResponseBytes {
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
			if call.Index < 0 || call.Index >= llm.MaxToolCalls {
				return errors.New("too many model tool calls")
			}
			for len(result.Calls) <= call.Index {
				result.Calls = append(result.Calls, llm.ToolCall{})
			}
			v := &result.Calls[call.Index]
			v.ID += call.ID
			v.Name += call.Function.Name
			v.Arguments += call.Function.Arguments
			if len(v.Arguments) > llm.MaxToolArguments || len(v.ID) > llm.MaxToolCallID || len(v.Name) > llm.MaxToolNameLength {
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

type usage struct {
	Prompt     int `json:"prompt_tokens"`
	Completion int `json:"completion_tokens"`
	CacheHit   int `json:"prompt_cache_hit_tokens"` // DeepSeek
	Prompts    struct {
		Cached int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	Completions struct {
		Reasoning int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

func (u usage) normal() llm.Usage {
	cached := u.Prompts.Cached
	if cached == 0 {
		cached = u.CacheHit
	}
	return llm.Usage{Input: u.Prompt, Output: u.Completion, Reasoning: u.Completions.Reasoning, CacheRead: cached}
}

// StatusError reads a vendor's short error message, so "model not found"
// or "invalid key" reaches the user instead of a bare status code. Vendors
// may echo the credential ("Invalid key: sk-…"), so every secret sent with
// the request is masked before the message reaches transcripts or channels.
func StatusError(resp *http.Response, secrets ...string) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	var body struct {
		Error any `json:"error"`
	}
	message := ""
	if json.Unmarshal(raw, &body) == nil {
		switch e := body.Error.(type) {
		case string:
			message = e
		case map[string]any:
			message, _ = e["message"].(string)
		}
	}
	for _, secret := range secrets {
		switch {
		case secret == "":
		case len(secret) < 4:
			// Masking every occurrence of a short value would leave nothing
			// readable, and the value could still be recovered; drop it all.
			message = ""
		default:
			message = strings.ReplaceAll(message, secret, "••••")
		}
	}
	message = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return ' '
		}
		return r
	}, strings.TrimSpace(message))
	if len([]rune(message)) > 200 {
		message = string([]rune(message)[:200]) + "…"
	}
	if message == "" {
		return fmt.Errorf("model returned HTTP %d", resp.StatusCode)
	}
	return fmt.Errorf("model returned HTTP %d: %s", resp.StatusCode, message)
}

// Secrets are the credentials a request carries: its key and header values.
func Secrets(key string, headers map[string]string) []string {
	out := []string{key}
	for _, v := range headers {
		out = append(out, v)
	}
	return out
}
