package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fdkevin0/mob/internal/gateway"
	"github.com/fdkevin0/mob/internal/node"
	"github.com/fdkevin0/mob/internal/protocol"
	"golang.org/x/net/websocket"
)

func TestGatewayNodeRelayAndSignaling(t *testing.T) {
	gwToken := "secret-token-123"
	gw := gateway.New(gateway.Config{
		Token: gwToken,
	})

	server := httptest.NewServer(gw.Handler())
	defer server.Close()

	// 1. Mock local application handler on the edge node
	localMux := http.NewServeMux()
	localMux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "hello from edge node"})
	})
	localMux.HandleFunc("GET /api/notfound", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "custom item missing", http.StatusNotFound)
	})
	localMux.HandleFunc("GET /api/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("x-vercel-ai-ui-message-stream", "v1")
		flusher := w.(http.Flusher)
		_, _ = w.Write([]byte("id: 1\ndata: {\"type\":\"delta\",\"text\":\"hello\"}\n\n"))
		flusher.Flush()
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		flusher.Flush()
	})

	var receivedSignal protocol.SignalPayload
	signalCh := make(chan protocol.SignalPayload, 1)

	nodeID := "node-macbook-pro"
	client := node.NewClient(server.URL, nodeID, gwToken, localMux)
	client.OnSignal = func(sig protocol.SignalPayload) {
		signalCh <- sig
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := client.Start(ctx); err != nil {
		t.Fatalf("failed to start node client: %v", err)
	}
	defer client.Close()

	// 2. Check Node listing via Gateway API, waiting for the node to register
	var listResult struct {
		Nodes []gateway.NodeInfo `json:"nodes"`
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		req, _ := http.NewRequest("GET", server.URL+"/api/gateway/nodes", nil)
		req.Header.Set("Authorization", "Bearer "+gwToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("list nodes failed: %v", err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		_ = json.NewDecoder(resp.Body).Decode(&listResult)
		resp.Body.Close()
		if len(listResult.Nodes) > 0 || time.Now().After(deadline) {
			break
		}
	}

	if len(listResult.Nodes) != 1 || listResult.Nodes[0].ID != nodeID {
		t.Fatalf("unexpected nodes: %+v", listResult.Nodes)
	}

	// 3. Test HTTP Relay through Gateway to Node
	relayReq, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/gateway/relay/%s/api/hello", server.URL, nodeID), nil)
	relayReq.Header.Set("Authorization", "Bearer "+gwToken)
	relayResp, err := http.DefaultClient.Do(relayReq)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	if relayResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(relayResp.Body)
		t.Fatalf("expected 200 from relay, got %d: %s", relayResp.StatusCode, string(body))
	}

	var relayData map[string]string
	_ = json.NewDecoder(relayResp.Body).Decode(&relayData)
	relayResp.Body.Close()

	if relayData["message"] != "hello from edge node" {
		t.Fatalf("unexpected relay response payload: %+v", relayData)
	}

	// 4. Test HTTP Status code propagation (404)
	errReq, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/gateway/relay/%s/api/notfound", server.URL, nodeID), nil)
	errReq.Header.Set("Authorization", "Bearer "+gwToken)
	errResp, err := http.DefaultClient.Do(errReq)
	if err != nil {
		t.Fatalf("err request failed: %v", err)
	}
	if errResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 from relay, got %d", errResp.StatusCode)
	}
	errResp.Body.Close()

	// 5. Test Streaming SSE Relay
	streamReq, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/gateway/relay/%s/api/stream", server.URL, nodeID), nil)
	streamReq.Header.Set("Authorization", "Bearer "+gwToken)
	streamResp, err := http.DefaultClient.Do(streamReq)
	if err != nil {
		t.Fatalf("stream req failed: %v", err)
	}
	if streamResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from stream, got %d", streamResp.StatusCode)
	}
	streamBody, _ := io.ReadAll(streamResp.Body)
	streamResp.Body.Close()
	if string(streamBody) != "id: 1\ndata: {\"type\":\"delta\",\"text\":\"hello\"}\n\ndata: [DONE]\n\n" || streamResp.Header.Get("x-vercel-ai-ui-message-stream") != "v1" || streamResp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream changed in transit: headers=%v, body=%q", streamResp.Header, streamBody)
	}

	// 6. Test WebRTC Signaling forward
	sigPayload := protocol.SignalPayload{
		TargetNodeID: nodeID,
		SourceNodeID: "client-browser-1",
		Kind:         "offer",
		Data:         "v=0\r\no=test 1 1 IN IP4 127.0.0.1",
	}
	sigBytes, _ := json.Marshal(sigPayload)
	sigReq, _ := http.NewRequest("POST", server.URL+"/api/gateway/signal", bytes.NewReader(sigBytes))
	sigReq.Header.Set("Authorization", "Bearer "+gwToken)
	sigReq.Header.Set("Content-Type", "application/json")

	sigResp, err := http.DefaultClient.Do(sigReq)
	if err != nil {
		t.Fatalf("signal request failed: %v", err)
	}
	if sigResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from signal, got %d", sigResp.StatusCode)
	}
	sigResp.Body.Close()

	select {
	case receivedSignal = <-signalCh:
		if receivedSignal.Kind != "offer" || receivedSignal.SourceNodeID != "client-browser-1" {
			t.Fatalf("mismatched signal payload received: %+v", receivedSignal)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for signal forward to node")
	}

	// 7. Test Unauthorized rejection
	unauthReq, _ := http.NewRequest("GET", server.URL+"/api/gateway/nodes", nil)
	unauthResp, err := http.DefaultClient.Do(unauthReq)
	if err != nil {
		t.Fatalf("unauth req failed: %v", err)
	}
	if unauthResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized, got %d", unauthResp.StatusCode)
	}
	unauthResp.Body.Close()
}

func TestReplacementNodeSurvivesOldDisconnect(t *testing.T) {
	gw := gateway.New(gateway.Config{Token: "fake"})
	oldDone := make(chan struct{})
	handler := gw.Handler()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("connection") == "old" {
			defer close(oldDone)
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	connect := func(name string) *websocket.Conn {
		t.Helper()
		ws, err := websocket.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/node?nodeId=same&token=fake&connection="+name, "", server.URL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ws.Close() })
		ws.SetDeadline(time.Now().Add(5 * time.Second))
		var hello protocol.Frame
		if err := websocket.JSON.Receive(ws, &hello); err != nil || hello.Method != "hello-ok" {
			t.Fatalf("registration: %+v, %v", hello, err)
		}
		return ws
	}
	old := connect("old")
	connect("new")
	old.Close()
	select {
	case <-oldDone:
	case <-time.After(time.Second):
		t.Fatal("old connection did not close")
	}
	req := httptest.NewRequest("GET", "/api/gateway/nodes", nil)
	req.Header.Set("Authorization", "Bearer fake")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	var result struct{ Nodes []gateway.NodeInfo }
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil || len(result.Nodes) != 1 || result.Nodes[0].ID != "same" {
		t.Fatalf("replacement lost: %s (%v)", recorder.Body, err)
	}
}
