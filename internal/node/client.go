package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/gateway"
	"github.com/fdkevin0/mob/internal/protocol"
	"golang.org/x/net/websocket"
)

// Client represents an edge node connected to a central Mob Gateway.
type Client struct {
	GatewayURL string
	NodeID     string
	Token      string
	Handler    http.Handler
	OnSignal   func(sig protocol.SignalPayload)

	ws        *websocket.Conn
	mu        sync.Mutex
	closing   bool
	closeOnce sync.Once
	closeCh   chan struct{}
}

// NewClient creates a new edge Node Client.
func NewClient(gatewayURL, nodeID, token string, localHandler http.Handler) *Client {
	return &Client{
		GatewayURL: gatewayURL,
		NodeID:     nodeID,
		Token:      token,
		Handler:    localHandler,
		closeCh:    make(chan struct{}),
	}
}

// Start initiates the persistent connection to the Gateway and reconnects on disconnect.
func (c *Client) Start(ctx context.Context) error {
	go c.runLoop(ctx)
	return nil
}

// Close disconnects the client from the Gateway.
func (c *Client) Close() error {
	c.mu.Lock()
	c.closing = true
	ws := c.ws
	c.mu.Unlock()

	c.closeOnce.Do(func() {
		close(c.closeCh)
	})

	if ws != nil {
		return ws.Close()
	}
	return nil
}

func (c *Client) runLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.closeCh:
			return
		default:
		}

		if err := c.connectAndServe(ctx); err != nil {
			c.mu.Lock()
			closing := c.closing
			c.mu.Unlock()
			if closing {
				return
			}

			select {
			case <-ctx.Done():
				return
			case <-c.closeCh:
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func (c *Client) connectAndServe(ctx context.Context) error {
	u, err := url.Parse(c.GatewayURL)
	if err != nil {
		return err
	}

	wsScheme := "ws"
	if u.Scheme == "https" || u.Scheme == "wss" {
		wsScheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/ws/node?nodeId=%s&token=%s", wsScheme, u.Host, url.QueryEscape(c.NodeID), url.QueryEscape(c.Token))
	origin := fmt.Sprintf("http://%s", u.Host)

	ws, err := websocket.Dial(wsURL, "", origin)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.ws = ws
	c.mu.Unlock()

	defer func() {
		_ = ws.Close()
		c.mu.Lock()
		c.ws = nil
		c.mu.Unlock()
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-c.closeCh:
			return nil
		default:
		}

		var frame protocol.Frame
		if err := websocket.JSON.Receive(ws, &frame); err != nil {
			return err
		}

		go c.handleFrame(frame)
	}
}

func (c *Client) handleFrame(frame protocol.Frame) {
	switch frame.Type {
	case protocol.FrameReq:
		if frame.Method == "http.relay" {
			c.handleRelayReq(frame)
		}
	case protocol.FrameSignal:
		if c.OnSignal != nil {
			var sig protocol.SignalPayload
			if err := json.Unmarshal(frame.Payload, &sig); err == nil {
				c.OnSignal(sig)
			}
		}
	}
}

func (c *Client) send(f protocol.Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ws == nil {
		return errors.New("not connected to gateway")
	}
	return websocket.JSON.Send(c.ws, f)
}

type relayResponseWriter struct {
	client     *Client
	frameID    string
	headers    http.Header
	statusCode int
	body       bytes.Buffer
	isStream   bool
}

func (w *relayResponseWriter) Header() http.Header {
	return w.headers
}

func (w *relayResponseWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	if strings.Contains(w.headers.Get("Content-Type"), "text/event-stream") {
		w.isStream = true
	}
}

func (w *relayResponseWriter) Write(data []byte) (int, error) {
	if w.statusCode == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if w.isStream {
		_ = w.client.send(protocol.Frame{
			ID:      w.frameID,
			Type:    protocol.FrameEvent,
			Payload: json.RawMessage(data),
		})
		return len(data), nil
	}
	return w.body.Write(data)
}

func (w *relayResponseWriter) Flush() {}

func (c *Client) handleRelayReq(frame protocol.Frame) {
	var relayReq gateway.RelayRequest
	if err := json.Unmarshal(frame.Payload, &relayReq); err != nil {
		_ = c.send(protocol.NewErrorRes(frame.ID, "bad_request", "invalid relay request payload"))
		return
	}

	httpReq, err := http.NewRequest(relayReq.Method, relayReq.Path, bytes.NewBufferString(relayReq.Body))
	if err != nil {
		_ = c.send(protocol.NewErrorRes(frame.ID, "internal_error", err.Error()))
		return
	}

	httpReq.Host = "localhost"
	for k, vals := range relayReq.Headers {
		for _, v := range vals {
			httpReq.Header.Add(k, v)
		}
	}

	rw := &relayResponseWriter{
		client:  c,
		frameID: frame.ID,
		headers: make(http.Header),
	}

	c.Handler.ServeHTTP(rw, httpReq)

	if rw.statusCode == 0 {
		rw.statusCode = http.StatusOK
	}

	if rw.isStream {
		_ = c.send(protocol.Frame{
			ID:   frame.ID,
			Type: protocol.FrameRes,
		})
		return
	}

	respPayload, _ := json.Marshal(gateway.RelayResponse{
		StatusCode: rw.statusCode,
		Headers:    rw.headers,
		Body:       rw.body.String(),
	})

	_ = c.send(protocol.Frame{
		ID:      frame.ID,
		Type:    protocol.FrameRes,
		Payload: respPayload,
	})
}
