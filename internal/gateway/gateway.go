package gateway

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/protocol"
	"golang.org/x/net/websocket"
)

// Config configures the Cloud Gateway service.
type Config struct {
	Token          string
	AllowedOrigins []string
	Assets         fs.FS
}

// NodeInfo represents summary information of an edge node.
type NodeInfo struct {
	ID          string    `json:"id"`
	ConnectedAt time.Time `json:"connectedAt"`
	RemoteAddr  string    `json:"remoteAddr"`
}

// NodeSession tracks a connected edge node.
type NodeSession struct {
	ID          string
	ConnectedAt time.Time
	RemoteAddr  string
	ws          *websocket.Conn
	mu          sync.Mutex
	pending     map[string]chan protocol.Frame
	pendingMu   sync.Mutex
}

func (n *NodeSession) send(f protocol.Frame) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	return websocket.JSON.Send(n.ws, f)
}

func (n *NodeSession) registerPending(reqID string) chan protocol.Frame {
	ch := make(chan protocol.Frame, 64)
	n.pendingMu.Lock()
	n.pending[reqID] = ch
	n.pendingMu.Unlock()
	return ch
}

func (n *NodeSession) unregisterPending(reqID string) {
	n.pendingMu.Lock()
	delete(n.pending, reqID)
	n.pendingMu.Unlock()
}

// Gateway manages node routing, client WebSockets, WebRTC signaling, and relaying.
type Gateway struct {
	Config  Config
	nodes   map[string]*NodeSession
	nodesMu sync.RWMutex
	signals chan protocol.SignalPayload
}

// New creates a new Gateway instance.
func New(cfg Config) *Gateway {
	return &Gateway{
		Config:  cfg,
		nodes:   make(map[string]*NodeSession),
		signals: make(chan protocol.SignalPayload, 128),
	}
}

// Handler returns the full HTTP / WebSocket handler for the Gateway.
func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()

	// 1. Gateway management & node listing
	mux.HandleFunc("GET /api/gateway/nodes", g.auth(g.handleListNodes))

	// 2. WebRTC signaling endpoint
	mux.HandleFunc("POST /api/gateway/signal", g.auth(g.handleSignal))

	// 3. Reverse HTTP relay to specific node
	mux.HandleFunc("/api/gateway/relay/{nodeId}/", g.auth(g.handleRelay))

	// 4. Node WebSocket registration endpoint
	mux.Handle("/ws/node", websocket.Handler(g.handleNodeWebSocket))

	// 5. Client WebSocket connection endpoint
	mux.Handle("/ws/client", websocket.Handler(g.handleClientWebSocket))

	// 6. Web SPA static assets
	if g.Config.Assets != nil {
		fileServer := http.FileServerFS(g.Config.Assets)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws/") {
				http.NotFound(w, r)
				return
			}
			fileServer.ServeHTTP(w, r)
		})
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")

		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Node-ID")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Vary", "Origin")
		}

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		mux.ServeHTTP(w, r)
	})
}

// auth middleware verifies bearer token or query token.
func (g *Gateway) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if g.Config.Token != "" {
			token := r.Header.Get("Authorization")
			if strings.HasPrefix(token, "Bearer ") {
				token = strings.TrimPrefix(token, "Bearer ")
			} else {
				token = r.URL.Query().Get("token")
			}
			if subtle.ConstantTimeCompare([]byte(token), []byte(g.Config.Token)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next(w, r)
	}
}

func (g *Gateway) handleListNodes(w http.ResponseWriter, r *http.Request) {
	g.nodesMu.RLock()
	defer g.nodesMu.RUnlock()

	nodes := make([]NodeInfo, 0, len(g.nodes))
	for _, n := range g.nodes {
		nodes = append(nodes, NodeInfo{
			ID:          n.ID,
			ConnectedAt: n.ConnectedAt,
			RemoteAddr:  n.RemoteAddr,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"nodes": nodes})
}

// RelayRequest describes an HTTP request to be proxied to an edge node.
type RelayRequest struct {
	Method  string              `json:"method"`
	Path    string              `json:"path"`
	Headers map[string][]string `json:"headers"`
	Body    string              `json:"body"`
}

// RelayResponse describes an HTTP response received from an edge node.
type RelayResponse struct {
	StatusCode int                 `json:"statusCode"`
	Headers    map[string][]string `json:"headers"`
	Body       string              `json:"body"`
}

func (g *Gateway) handleRelay(w http.ResponseWriter, r *http.Request) {
	nodeID := r.PathValue("nodeId")
	g.nodesMu.RLock()
	node, ok := g.nodes[nodeID]
	g.nodesMu.RUnlock()

	if !ok {
		http.Error(w, fmt.Sprintf("Node %q is offline or not found", nodeID), http.StatusBadGateway)
		return
	}

	// Extract path after /api/gateway/relay/{nodeId}
	prefix := "/api/gateway/relay/" + nodeID
	relPath := strings.TrimPrefix(r.URL.Path, prefix)
	if !strings.HasPrefix(relPath, "/") {
		relPath = "/" + relPath
	}
	if r.URL.RawQuery != "" {
		relPath += "?" + r.URL.RawQuery
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body failed", http.StatusBadRequest)
		return
	}

	reqID := fmt.Sprintf("req-%d", time.Now().UnixNano())
	relayReq := RelayRequest{
		Method:  r.Method,
		Path:    relPath,
		Headers: r.Header,
		Body:    string(bodyBytes),
	}

	frame, err := protocol.NewReq(reqID, "http.relay", nodeID, relayReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	ch := node.registerPending(reqID)
	defer node.unregisterPending(reqID)

	if err := node.send(frame); err != nil {
		http.Error(w, "failed to dispatch to node: "+err.Error(), http.StatusBadGateway)
		return
	}

	flusher, isFlusher := w.(http.Flusher)
	w.Header().Set("Cache-Control", "no-cache")

	var streamingStarted bool
	for {
		select {
		case <-r.Context().Done():
			return
		case respFrame, ok := <-ch:
			if !ok {
				return
			}
			if respFrame.Type == protocol.FrameEvent {
				if !streamingStarted {
					streamingStarted = true
					if w.Header().Get("Content-Type") == "" {
						w.Header().Set("Content-Type", "text/event-stream")
					}
				}
				fmt.Fprintf(w, "data: %s\n\n", string(respFrame.Payload))
				if isFlusher {
					flusher.Flush()
				}
			} else if respFrame.Type == protocol.FrameRes {
				if respFrame.Error != nil {
					http.Error(w, respFrame.Error.Message, http.StatusBadGateway)
					return
				}
				if streamingStarted {
					return
				}

				var relayResp RelayResponse
				if err := json.Unmarshal(respFrame.Payload, &relayResp); err == nil && relayResp.StatusCode > 0 {
					for k, vals := range relayResp.Headers {
						for _, v := range vals {
							w.Header().Add(k, v)
						}
					}
					w.WriteHeader(relayResp.StatusCode)
					_, _ = w.Write([]byte(relayResp.Body))
				} else {
					if w.Header().Get("Content-Type") == "" {
						w.Header().Set("Content-Type", "application/json")
					}
					_, _ = w.Write(respFrame.Payload)
				}
				if isFlusher {
					flusher.Flush()
				}
				return
			}
		case <-time.After(30 * time.Second):
			http.Error(w, "gateway timeout awaiting node response", http.StatusGatewayTimeout)
			return
		}
	}
}

func (g *Gateway) handleSignal(w http.ResponseWriter, r *http.Request) {
	var sig protocol.SignalPayload
	if err := json.NewDecoder(r.Body).Decode(&sig); err != nil {
		http.Error(w, "invalid signaling body", http.StatusBadRequest)
		return
	}

	g.nodesMu.RLock()
	targetNode, ok := g.nodes[sig.TargetNodeID]
	g.nodesMu.RUnlock()

	if !ok {
		http.Error(w, "target node offline", http.StatusNotFound)
		return
	}

	sigFrame := protocol.Frame{
		Type:    protocol.FrameSignal,
		Method:  "webrtc.signal",
		NodeID:  sig.SourceNodeID,
		Payload: nil,
	}
	raw, _ := json.Marshal(sig)
	sigFrame.Payload = raw

	if err := targetNode.send(sigFrame); err != nil {
		http.Error(w, "failed to forward signal: "+err.Error(), http.StatusBadGateway)
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]bool{"relayed": true})
}

func (g *Gateway) handleNodeWebSocket(ws *websocket.Conn) {
	nodeID := ws.Request().URL.Query().Get("nodeId")
	token := ws.Request().URL.Query().Get("token")

	if g.Config.Token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(g.Config.Token)) != 1 {
		_ = websocket.JSON.Send(ws, protocol.NewErrorRes("", "unauthorized", "invalid gateway token"))
		_ = ws.Close()
		return
	}
	if nodeID == "" {
		_ = websocket.JSON.Send(ws, protocol.NewErrorRes("", "bad_request", "nodeId query parameter required"))
		_ = ws.Close()
		return
	}

	session := &NodeSession{
		ID:          nodeID,
		ConnectedAt: time.Now(),
		RemoteAddr:  ws.Request().RemoteAddr,
		ws:          ws,
		pending:     make(map[string]chan protocol.Frame),
	}

	g.nodesMu.Lock()
	g.nodes[nodeID] = session
	g.nodesMu.Unlock()

	defer func() {
		g.nodesMu.Lock()
		delete(g.nodes, nodeID)
		g.nodesMu.Unlock()
		_ = ws.Close()
	}()

	_ = session.send(protocol.Frame{
		Type:   protocol.FrameRes,
		Method: "hello-ok",
		NodeID: nodeID,
	})

	for {
		var frame protocol.Frame
		if err := websocket.JSON.Receive(ws, &frame); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		if frame.ID != "" {
			session.pendingMu.Lock()
			ch, ok := session.pending[frame.ID]
			session.pendingMu.Unlock()
			if ok {
				select {
				case ch <- frame:
				default:
					// Drop if pending consumer has exited or buffer saturated to prevent blocking the WebSocket loop
				}
			}
		}
	}
}

func (g *Gateway) handleClientWebSocket(ws *websocket.Conn) {
	token := ws.Request().URL.Query().Get("token")
	if g.Config.Token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(g.Config.Token)) != 1 {
		_ = websocket.JSON.Send(ws, protocol.NewErrorRes("", "unauthorized", "invalid token"))
		_ = ws.Close()
		return
	}

	defer func() {
		_ = ws.Close()
	}()

	for {
		var frame protocol.Frame
		if err := websocket.JSON.Receive(ws, &frame); err != nil {
			return
		}

		if frame.NodeID != "" {
			g.nodesMu.RLock()
			targetNode, ok := g.nodes[frame.NodeID]
			g.nodesMu.RUnlock()
			if ok {
				_ = targetNode.send(frame)
			} else {
				_ = websocket.JSON.Send(ws, protocol.NewErrorRes(frame.ID, "node_offline", "target node offline"))
			}
		}
	}
}
