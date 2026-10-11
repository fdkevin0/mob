package protocol

import "encoding/json"

// FrameType represents the classification of a mesh communication frame.
type FrameType string

const (
	FrameReq    FrameType = "req"
	FrameRes    FrameType = "res"
	FrameEvent  FrameType = "event"
	FrameSignal FrameType = "signal"
	FramePing   FrameType = "ping"
	FramePong   FrameType = "pong"
)

// FrameError defines an error payload inside a response or event frame.
type FrameError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Frame is the universal transmission unit across Mesh Nodes, Gateways, and Web clients.
type Frame struct {
	ID        string          `json:"id,omitempty"`
	Type      FrameType       `json:"type"`
	Method    string          `json:"method,omitempty"`
	NodeID    string          `json:"nodeId,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Error     *FrameError     `json:"error,omitempty"`
	Timestamp int64           `json:"timestamp,omitempty"`
}

// SignalPayload carries WebRTC signaling information (SDP offer/answer or ICE candidate).
type SignalPayload struct {
	TargetNodeID string `json:"targetNodeId"`
	SourceNodeID string `json:"sourceNodeId"`
	Kind         string `json:"kind"` // "offer", "answer", "candidate"
	Data         string `json:"data"` // SDP string or ICE candidate JSON
}

// NewReq creates a request frame.
func NewReq(id, method, nodeID string, payload any) (Frame, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return Frame{}, err
	}
	return Frame{
		ID:      id,
		Type:    FrameReq,
		Method:  method,
		NodeID:  nodeID,
		Payload: raw,
	}, nil
}

// NewRes creates a successful response frame.
func NewRes(id string, payload any) (Frame, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return Frame{}, err
	}
	return Frame{
		ID:      id,
		Type:    FrameRes,
		Payload: raw,
	}, nil
}

// NewErrorRes creates an error response frame.
func NewErrorRes(id, code, message string) Frame {
	return Frame{
		ID:   id,
		Type: FrameRes,
		Error: &FrameError{
			Code:    code,
			Message: message,
		},
	}
}

// NewEvent creates an asynchronous event or streaming chunk frame.
func NewEvent(sessionID, method string, payload any) (Frame, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return Frame{}, err
	}
	return Frame{
		Type:      FrameEvent,
		Method:    method,
		SessionID: sessionID,
		Payload:   raw,
	}, nil
}
