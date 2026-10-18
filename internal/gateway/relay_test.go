package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/protocol"
	"golang.org/x/net/websocket"
)

func connectSocket(t *testing.T, server *httptest.Server, path string) *websocket.Conn {
	t.Helper()
	ws, err := websocket.Dial("ws"+strings.TrimPrefix(server.URL, "http")+path, "", server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	ws.SetDeadline(time.Now().Add(40 * time.Second))
	return ws
}
func receiveFrame(t *testing.T, ws *websocket.Conn) protocol.Frame {
	t.Helper()
	var f protocol.Frame
	if err := websocket.JSON.Receive(ws, &f); err != nil {
		t.Fatal(err)
	}
	return f
}
func sendFrame(t *testing.T, ws *websocket.Conn, f protocol.Frame) {
	t.Helper()
	if err := websocket.JSON.Send(ws, f); err != nil {
		t.Fatal(err)
	}
}

func TestClientRepliesKeepTheirCaller(t *testing.T) {
	g := New(Config{Token: "fake"})
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	node := connectSocket(t, server, "/ws/node?nodeId=n&token=fake")
	receiveFrame(t, node)
	clients := []*websocket.Conn{connectSocket(t, server, "/ws/client?token=fake"), connectSocket(t, server, "/ws/client?token=fake")}
	var requests []protocol.Frame
	for i, client := range clients {
		req, _ := protocol.NewReq("same-id", "http.relay", "n", i)
		sendFrame(t, client, req)
		requests = append(requests, receiveFrame(t, node))
	}
	if requests[0].ID == requests[1].ID {
		t.Fatal("clients share a routing ID")
	}
	// Return in reverse order, including a streamed event before each result.
	for i := 1; i >= 0; i-- {
		for _, kind := range []protocol.FrameType{protocol.FrameEvent, protocol.FrameRes} {
			sendFrame(t, node, protocol.Frame{ID: requests[i].ID, Type: kind, Payload: requests[i].Payload})
			got := receiveFrame(t, clients[i])
			if got.ID != "same-id" || got.Type != kind || string(got.Payload) != string(requests[i].Payload) {
				t.Fatalf("misrouted response: %+v", got)
			}
		}
	}
	req, _ := protocol.NewReq("disconnect", "http.relay", "n", nil)
	sendFrame(t, clients[0], req)
	receiveFrame(t, node)
	node.Close()
	got := receiveFrame(t, clients[0])
	if got.ID != "disconnect" || got.Error == nil || got.Error.Code != "node_offline" {
		t.Fatalf("disconnect not reported: %+v", got)
	}
}

func TestSlowConsumerFailsWithoutLosingCompletionSilently(t *testing.T) {
	n := &NodeSession{pending: make(map[string]chan protocol.Frame)}
	slow := n.registerPending("slow")
	fast := n.registerPending("fast")
	for i := 0; i < cap(slow); i++ {
		n.route(protocol.Frame{ID: "slow", Type: protocol.FrameEvent})
	}
	n.route(protocol.Frame{ID: "slow", Type: protocol.FrameRes})
	failed := <-slow
	if failed.Error == nil || failed.Error.Code != "slow_consumer" {
		t.Fatalf("no explicit failure: %+v", failed)
	}
	if _, ok := <-slow; ok {
		t.Fatal("overloaded stream left open")
	}
	n.route(protocol.Frame{ID: "fast", Type: protocol.FrameRes})
	if got := <-fast; got.Type != protocol.FrameRes || got.Error != nil {
		t.Fatalf("other request affected: %+v", got)
	}
	n.disconnect()
	if _, ok := <-n.registerPending("late"); ok {
		t.Fatal("request admitted on disconnected node")
	}
}

func TestRelayAllowsToolPause(t *testing.T) {
	t.Parallel()
	g := New(Config{Token: "fake"})
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	node := connectSocket(t, server, "/ws/node?nodeId=n&token=fake")
	receiveFrame(t, node)
	result := make(chan string, 1)
	go func() {
		req, _ := http.NewRequest("GET", server.URL+"/api/gateway/relay/n/api/stream", nil)
		req.Header.Set("Authorization", "Bearer fake")
		client := http.Client{Timeout: 40 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			result <- err.Error()
			return
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			result <- err.Error()
			return
		}
		result <- string(raw)
	}()
	req := receiveFrame(t, node)
	payload, _ := json.Marshal(RelayResponse{StatusCode: 200, Headers: map[string][]string{"Content-Type": {"text/event-stream"}}, Body: "data: started\n\n"})
	sendFrame(t, node, protocol.Frame{ID: req.ID, Type: protocol.FrameEvent, Payload: payload})
	// A tool can be silent longer than the old 30-second relay timeout.
	time.Sleep(31 * time.Second)
	payload, _ = json.Marshal(RelayResponse{Body: "data: [DONE]\n\n"})
	sendFrame(t, node, protocol.Frame{ID: req.ID, Type: protocol.FrameEvent, Payload: payload})
	sendFrame(t, node, protocol.Frame{ID: req.ID, Type: protocol.FrameRes})
	if got := <-result; got != "data: started\n\ndata: [DONE]\n\n" {
		t.Fatalf("tool pause interrupted stream: %q", got)
	}
}

func TestRelayFailureAbortsStartedHTTPStream(t *testing.T) {
	g := New(Config{Token: "fake"})
	server := httptest.NewServer(g.Handler())
	defer server.Close()
	node := connectSocket(t, server, "/ws/node?nodeId=n&token=fake")
	receiveFrame(t, node)
	started := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		req, _ := http.NewRequest("GET", server.URL+"/api/gateway/relay/n/api/stream", nil)
		req.Header.Set("Authorization", "Bearer fake")
		client := http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			close(started)
			result <- err
			return
		}
		defer resp.Body.Close()
		first := make([]byte, len("data: started\n\n"))
		_, err = io.ReadFull(resp.Body, first)
		close(started)
		if err != nil {
			result <- err
			return
		}
		_, err = io.ReadAll(resp.Body)
		result <- err
	}()
	req := receiveFrame(t, node)
	payload, _ := json.Marshal(RelayResponse{StatusCode: 200, Headers: map[string][]string{"Content-Type": {"text/event-stream"}}, Body: "data: started\n\n"})
	sendFrame(t, node, protocol.Frame{ID: req.ID, Type: protocol.FrameEvent, Payload: payload})
	<-started
	sendFrame(t, node, protocol.NewErrorRes(req.ID, "slow_consumer", "stream is incomplete"))
	if err := <-result; err != io.ErrUnexpectedEOF {
		t.Fatalf("incomplete stream should fail with unexpected EOF, got %v", err)
	}
}
