package node

import (
	"net/http"
	"testing"
)

func TestStreamWriteReportsDisconnectedGateway(t *testing.T) {
	w := &relayResponseWriter{client: &Client{}, headers: make(http.Header)}
	w.Header().Set("Content-Type", "text/event-stream")
	if n, err := w.Write([]byte("data: [DONE]\n\n")); err == nil || n != 0 || w.streamed {
		t.Fatalf("disconnected stream reported a successful write: n=%d, err=%v, streamed=%v", n, err, w.streamed)
	}
}
