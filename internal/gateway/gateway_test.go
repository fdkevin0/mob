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
		flusher := w.(http.Flusher)
		_, _ = w.Write([]byte(`{"type":"delta","text":"hello"}`))
		flusher.Flush()
		_, _ = w.Write([]byte(`{"type":"finish"}`))
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
	if !strings.Contains(string(streamBody), "text-event-stream") && !strings.Contains(string(streamBody), "delta") {
		t.Fatalf("expected streamed event data in body, got: %s", string(streamBody))
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
