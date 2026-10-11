// Package anthropic speaks Anthropic Messages, served by Anthropic and by
// vendors that offer an Anthropic-compatible endpoint (DeepSeek, Kimi, GLM).
package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/llm/openai"
)

const version = "2023-06-01"

type Config struct {
	BaseURL, Key string
	Headers      map[string]string
	Transport    http.RoundTripper
}

type Model struct {
	ref    llm.Ref
	info   llm.Info
	config Config
}

func New(ref llm.Ref, info llm.Info, c Config) *Model { return &Model{ref, info, c} }
func (m *Model) Ref() llm.Ref                         { return m.ref }
func (m *Model) Info() llm.Info                       { return m.info }

// defaultOutput is the reply size for a model whose output limit is unknown.
const defaultOutput = 32000

// budgets are thinking tokens per effort; "none" leaves thinking off.
var budgets = map[string]int{"minimal": 1024, "low": 2048, "medium": 4096, "high": 8192, "xhigh": 16384, "max": 32000}

var unsafeID = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// toolID adapts IDs another vendor issued to the pattern Anthropic accepts.
func toolID(id string) string { return unsafeID.ReplaceAllString(id, "_") }

func messages(req llm.Request) []map[string]any {
	var out []map[string]any
	add := func(role string, blocks ...map[string]any) {
		if len(blocks) == 0 {
			return
		}
		// Consecutive turns of one role are merged: tool results answering
		// one assistant turn must arrive in a single user message.
		if n := len(out); n > 0 && out[n-1]["role"] == role {
			out[n-1]["content"] = append(out[n-1]["content"].([]map[string]any), blocks...)
			return
		}
		out = append(out, map[string]any{"role": role, "content": blocks})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case "tool":
			add("user", map[string]any{"type": "tool_result", "tool_use_id": toolID(m.ToolCallID), "content": m.Text})
		case "assistant":
			var blocks []map[string]any
			if m.Reasoning != "" && m.Signature != "" {
				blocks = append(blocks, map[string]any{"type": "thinking", "thinking": m.Reasoning, "signature": m.Signature})
			}
			if m.Text != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Text})
			}
			for _, c := range m.ToolCalls {
				input := json.RawMessage(c.Arguments)
				if !json.Valid(input) || !bytes.HasPrefix(bytes.TrimSpace(input), []byte("{")) {
					input = json.RawMessage("{}")
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": toolID(c.ID), "name": c.Name, "input": input})
			}
			add("assistant", blocks...)
		default:
			if m.Text != "" {
				add("user", map[string]any{"type": "text", "text": m.Text})
			}
		}
	}
	return out
}

func (m *Model) Stream(ctx context.Context, req llm.Request, emit func(kind, delta string) error) (llm.Result, error) {
	var result llm.Result
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultOutput
	}
	body := map[string]any{"model": m.ref.Model, "messages": messages(req), "stream": true}
	if req.System != "" {
		body["system"] = req.System
	}
	if limit := m.info.Output; limit > 0 {
		maxTokens = min(maxTokens, limit)
	}
	// Thinking shares the requested tokens, which the caller reserved in the
	// context, and leaves at least half of them for the answer. Anthropic
	// requires at least 1024 thinking tokens, so a small reply goes without.
	if budget := min(budgets[m.ref.Effort], maxTokens/2); budget >= 1024 {
		body["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
	}
	body["max_tokens"] = maxTokens
	if len(req.Tools) > 0 {
		ts := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			ts[i] = map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.Parameters}
		}
		body["tools"] = ts
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return result, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(m.config.BaseURL, "/")+"/v1/messages", bytes.NewReader(raw))
	if err != nil {
		return result, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("anthropic-version", version)
	if m.config.Key != "" {
		httpReq.Header.Set("x-api-key", m.config.Key)
	}
	for k, v := range m.config.Headers {
		httpReq.Header.Set(k, v)
	}
	resp, err := llm.Send(m.config.Transport, httpReq)
	if err != nil {
		return result, fmt.Errorf("model connection failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return result, openai.StatusError(resp, openai.Secrets(m.config.Key, m.config.Headers)...)
	}
	var u llm.Usage
	blocks := map[int]int{} // content block index → tool call index, for tool_use blocks
	stopped, size := false, 0
	err = llm.ReadSSE(resp.Body, func(_ string, data []byte) error {
		var e struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message struct {
				Usage usage `json:"usage"`
			} `json:"message"`
			Usage usage `json:"usage"`
			Block struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta struct {
				Type      string `json:"type"`
				Text      string `json:"text"`
				Thinking  string `json:"thinking"`
				Signature string `json:"signature"`
				JSON      string `json:"partial_json"`
			} `json:"delta"`
		}
		if err := json.Unmarshal(data, &e); err != nil {
			return errors.New("invalid model stream JSON")
		}
		switch e.Type {
		case "error":
			return errors.New("model reported a stream error")
		case "message_start":
			u = e.Message.Usage.normal()
		case "message_delta":
			u.Output = e.Usage.Output
		case "message_stop":
			stopped = true
		case "content_block_start":
			if e.Block.Type == "tool_use" {
				if len(result.Calls) >= llm.MaxToolCalls {
					return errors.New("too many model tool calls")
				}
				blocks[e.Index] = len(result.Calls)
				result.Calls = append(result.Calls, llm.ToolCall{ID: e.Block.ID, Name: e.Block.Name})
				if len(e.Block.ID) > llm.MaxToolCallID || len(e.Block.Name) > llm.MaxToolNameLength {
					return errors.New("model tool call exceeded limit")
				}
			}
		case "content_block_delta":
			kind, text := "", ""
			switch e.Delta.Type {
			case "text_delta":
				kind, text = "text", e.Delta.Text
				result.Text += text
			case "thinking_delta":
				kind, text = "reasoning", e.Delta.Thinking
				result.Reasoning += text
			case "signature_delta":
				result.Signature += e.Delta.Signature
			case "input_json_delta":
				i, ok := blocks[e.Index]
				if !ok {
					return errors.New("model sent tool input outside a tool call")
				}
				result.Calls[i].Arguments += e.Delta.JSON
				if len(result.Calls[i].Arguments) > llm.MaxToolArguments {
					return errors.New("model tool call exceeded limit")
				}
			}
			size += len(text)
			if size > llm.MaxResponseBytes {
				return errors.New("model response exceeded limit")
			}
			if text != "" {
				return emit(kind, text)
			}
		}
		return nil
	})
	if err == nil && !stopped {
		err = errors.New("model stream ended before completion")
	}
	for i := range result.Calls {
		if result.Calls[i].Arguments == "" {
			result.Calls[i].Arguments = "{}"
		}
	}
	result.Usage = &u
	return result, err
}

type usage struct {
	Input      int `json:"input_tokens"`
	Output     int `json:"output_tokens"`
	CacheRead  int `json:"cache_read_input_tokens"`
	CacheWrite int `json:"cache_creation_input_tokens"`
}

func (u usage) normal() llm.Usage {
	return llm.Usage{Input: u.Input + u.CacheRead + u.CacheWrite, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}
}
