package protocol

import (
	"encoding/json"
	"testing"
)

func TestMeshFrames(t *testing.T) {
	req, err := NewReq("req-1", "agent.send", "node-alpha", map[string]string{"text": "hello"})
	if err != nil {
		t.Fatalf("failed to create req frame: %v", err)
	}
	if req.Type != FrameReq || req.ID != "req-1" || req.Method != "agent.send" {
		t.Fatalf("unexpected req frame: %+v", req)
	}

	res, err := NewRes("req-1", map[string]bool{"ok": true})
	if err != nil {
		t.Fatalf("failed to create res frame: %v", err)
	}
	if res.Type != FrameRes || res.ID != "req-1" {
		t.Fatalf("unexpected res frame: %+v", res)
	}

	errRes := NewErrorRes("req-2", "not_found", "Node unavailable")
	if errRes.Error == nil || errRes.Error.Code != "not_found" {
		t.Fatalf("unexpected error frame: %+v", errRes)
	}

	evt, err := NewEvent("sess-1", "chat.delta", Chunk{Type: "text-delta", Delta: "hi"})
	if err != nil {
		t.Fatalf("failed to create event frame: %v", err)
	}
	if evt.Type != FrameEvent || evt.SessionID != "sess-1" {
		t.Fatalf("unexpected event frame: %+v", evt)
	}

	// Verify serialization and deserialization
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var unmarshaled Frame
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if unmarshaled.Method != "agent.send" || unmarshaled.NodeID != "node-alpha" {
		t.Fatalf("unmarshaled mismatch: %+v", unmarshaled)
	}
}
