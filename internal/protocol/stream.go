// Package protocol adapts conversation events to the AI SDK UI wire format.
package protocol

import "github.com/fdkevin0/mob/internal/chat"

type Chunk struct {
	Type         string `json:"type"`
	MessageID    string `json:"messageId,omitempty"`
	FinishReason string `json:"finishReason,omitempty"`
	ErrorText    string `json:"errorText,omitempty"`
	ID           string `json:"id,omitempty"`
	Delta        string `json:"delta,omitempty"`
	Data         any    `json:"data,omitempty"`
	ToolCallID   string `json:"toolCallId,omitempty"`
	ToolName     string `json:"toolName,omitempty"`
	Input        any    `json:"input,omitempty"`
	Output       any    `json:"output,omitempty"`
	ApprovalID   string `json:"approvalId,omitempty"`
}

func Encode(e chat.Event) Chunk {
	kind := ""
	switch e.Kind {
	case chat.TurnStarted:
		kind = "start"
	case chat.StepStarted:
		kind = "start-step"
	case chat.SegmentStarted:
		kind = e.Segment + "-start"
	case chat.SegmentDelta:
		kind = e.Segment + "-delta"
	case chat.SegmentFinished:
		kind = e.Segment + "-end"
	case chat.UsageReported:
		kind = "data-usage"
	case chat.ToolInput:
		kind = "tool-input-available"
	case chat.ToolOutput:
		kind = "tool-output-available"
	case chat.ToolFailed:
		kind = "tool-output-error"
	case chat.ApprovalRequested:
		kind = "tool-approval-request"
	case chat.StepFinished:
		kind = "finish-step"
	case chat.TurnFinished:
		kind = "finish"
	case chat.TurnAborted:
		kind = "abort"
	case chat.TurnFailed:
		kind = "error"
	default:
		panic("unknown conversation event")
	}
	return Chunk{Type: kind, MessageID: e.MessageID, FinishReason: e.Reason, ErrorText: e.Error, ID: e.ID, Delta: e.Text, Data: e.Usage, ToolCallID: e.ToolCallID, ToolName: e.ToolName, Input: e.Input, Output: e.Output, ApprovalID: e.ApprovalID}
}
