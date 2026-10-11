package chat

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Conversation owns execution, cancellation and admission for every transport.
type ConversationService struct {
	Store    *Store
	provider Provider
	mu       sync.Mutex
	active   map[string]context.CancelFunc
	wg       sync.WaitGroup
	closing  bool
}

type CommandError struct {
	Status  int
	Message string
}

func (e *CommandError) Error() string { return e.Message }

func (s *ConversationService) Execute(parent context.Context, input ChatRequest, emit func(Event) error) error {
	input.Text = strings.TrimSpace(input.Text)
	if len(input.ID) != 32 || len(input.Text) > 16000 || (input.Approval == nil && (input.Text == "" || len(input.RequestID) == 0 || len(input.RequestID) > 100)) || (input.Approval != nil && (input.Text != "" || len(input.Approval.ID) != 32)) {
		return &CommandError{400, "invalid conversation, text, request ID, or approval"}
	}
	s.mu.Lock()
	provider := s.provider
	s.mu.Unlock()
	if !provider.Demo && provider.APIKey == "" {
		return &CommandError{503, "Configure DEEPSEEK_API_KEY or MOB_API_KEY, or start with MOB_DEMO=1."}
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	s.mu.Lock()
	if _, busy := s.active[input.ID]; busy || s.closing {
		s.mu.Unlock()
		cancel()
		return &CommandError{409, "conversation is busy; wait or stop the active turn"}
	}
	s.active[input.ID] = cancel
	s.wg.Add(1)
	s.mu.Unlock()
	defer func() { cancel(); s.mu.Lock(); delete(s.active, input.ID); s.mu.Unlock(); s.wg.Done() }()
	if _, err := s.Store.History(input.ID); err != nil {
		return err
	}
	note := ""
	if input.Approval != nil {
		var err error
		note, err = s.Store.Decide(input.ID, input.Approval.ID, input.Approval.Approved)
		if err != nil {
			return err
		}
		if !input.Approval.Approved {
			return emit(Event{Kind: TurnFinished, Reason: "stop"})
		}
	}
	message, err := s.Store.Begin(input.ID, input.RequestID, input.Text)
	if err != nil {
		if s.Store.HasRequest(input.RequestID) {
			return &CommandError{409, "request already accepted; refresh history"}
		}
		return err
	}
	err = Run(ctx, s.Store, provider, input.ID, message, note, emit)
	if err != nil {
		return err
	}
	return emit(Event{Kind: TurnFinished, Reason: "stop"})
}

func NewConversation(store *Store, provider Provider) *ConversationService {
	return &ConversationService{Store: store, provider: provider, active: map[string]context.CancelFunc{}}
}
func (s *ConversationService) Provider() Provider {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.provider
}
func (s *ConversationService) SetProvider(provider Provider) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.provider = provider
}
func (s *ConversationService) Active(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.active[id]
	return ok
}
func (s *ConversationService) Stop(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cancel := s.active[id]
	if cancel != nil {
		cancel()
	}
	return cancel != nil
}
func (s *ConversationService) Close() {
	s.mu.Lock()
	s.closing = true
	for _, cancel := range s.active {
		cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

type ChatRequest struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	RequestID string `json:"requestId"`
	Approval  *struct {
		ID       string `json:"id"`
		Approved bool   `json:"approved"`
	} `json:"approval,omitempty"`
}
