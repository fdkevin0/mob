package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// eventsHeartbeat keeps an idle stream open through proxies and the relay,
// which end a response that stays silent for minutes.
const eventsHeartbeat = 25 * time.Second

// events streams what changed in the store as server-sent events, so clients
// reload only what changed instead of polling. A client reloads everything
// when it connects, as no history is kept; a stream that fell behind ends,
// and its client reconnects.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	changes, stop := s.Store.Changes.Subscribe()
	defer stop()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	flush := func() error { return http.NewResponseController(w).Flush() }
	if _, err := fmt.Fprint(w, "retry: 2000\n: ready\n\n"); err != nil || flush() != nil {
		return
	}
	heartbeat := time.NewTicker(eventsHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.closed:
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil || flush() != nil {
				return
			}
		case change, ok := <-changes:
			if !ok {
				return
			}
			raw, _ := json.Marshal(change)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil || flush() != nil {
				return
			}
		}
	}
}
