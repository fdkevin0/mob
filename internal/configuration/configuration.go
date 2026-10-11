package configuration

import (
	"sync"

	"github.com/fdkevin0/mob/internal/chat"
)

// Service owns plugin configuration saved in SQLite. Model providers live in
// providers.json (package provider).
type Service struct {
	Store *chat.Store
	mu    sync.Mutex
}

// Snapshot is what clients learn about models when they connect.
type Snapshot struct {
	DefaultModel string `json:"defaultModel"`
	Demo         bool   `json:"demo"`
}
