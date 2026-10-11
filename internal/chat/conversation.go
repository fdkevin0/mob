package chat

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/llm"
)

// Models resolves model references; provider.Registry implements it.
type Models interface {
	// Default is the reference a conversation uses until /model picks another.
	Default() string
	Resolve(query string) (llm.Model, error)
	SetDefault(query string) (llm.Ref, error)
	List(ctx context.Context, query string) []llm.Group
}

// Conversation owns execution, cancellation and admission for every transport.
type ConversationService struct {
	Store  *Store
	Models Models
	// Commands answers slash commands; register more before serving.
	Commands *Registry
	mu       sync.Mutex
	sandbox  Sandbox
	active   map[string]context.CancelFunc
	wg       sync.WaitGroup
	closing  bool
}

type CommandError struct {
	Status  int
	Message string
}

func (e *CommandError) Error() string { return e.Message }

// Model is the reference a conversation's next turn uses.
func (s *ConversationService) Model(id string) (string, error) {
	ref, err := s.Store.ConversationModel(id)
	if err != nil || ref != "" {
		return ref, err
	}
	return s.Models.Default(), nil
}

func (s *ConversationService) Execute(parent context.Context, input ChatRequest, emit func(Event) error) error {
	input.Text = strings.TrimSpace(input.Text)
	if len(input.ID) != 32 || len(input.Text) > 16000 || (input.Approval == nil && (input.Text == "" || len(input.RequestID) == 0 || len(input.RequestID) > 100)) || (input.Approval != nil && (input.Text != "" || len(input.Approval.ID) != 32)) {
		return &CommandError{400, "invalid conversation, text, request ID, or approval"}
	}
	if _, err := s.Store.History(input.ID); err != nil {
		return err
	}
	command := input.Approval == nil && s.Commands.transcript(input.Text)
	var model llm.Model
	if !command {
		ref, err := s.Model(input.ID)
		if err != nil {
			return err
		}
		if ref == "" {
			return &CommandError{503, "No model is configured. Add a provider with `mob provider add`, then pick a model with /model."}
		}
		if model, err = s.Models.Resolve(ref); err != nil {
			return &CommandError{503, "Model " + ref + " is unavailable: " + err.Error() + ". Use /models to pick another."}
		}
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
	if command {
		return s.command(ctx, input, emit)
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
	message, err := s.Store.Begin(input.ID, input.RequestID, input.Text, model.Ref().String())
	if err != nil {
		if s.Store.HasRequest(input.RequestID) {
			return &CommandError{409, "request already accepted; refresh history"}
		}
		return err
	}
	s.mu.Lock()
	box := s.sandbox
	s.mu.Unlock()
	err = Run(ctx, s.Store, model, box, input.ID, message, note, emit)
	if err != nil {
		return err
	}
	return emit(Event{Kind: TurnFinished, Reason: "stop"})
}

func NewConversation(store *Store, models Models) *ConversationService {
	s := &ConversationService{Store: store, Models: models, Commands: &Registry{}, active: map[string]context.CancelFunc{}}
	s.Commands.Register(s.builtins()...)
	return s
}

// SetSandbox changes the sandbox later turns use; nil disables it.
func (s *ConversationService) SetSandbox(box Sandbox) {
	s.mu.Lock()
	s.sandbox = box
	s.mu.Unlock()
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
	// Owner is set by transports for the person who runs Mob: the local
	// UI, and a channel's owner. Only the owner may switch models, which
	// spends their provider credit. Never decoded from a request body.
	Owner bool `json:"-"`
}
