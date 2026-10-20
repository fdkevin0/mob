package chat

import "sync"

// Notice is news for the owner about a conversation they may not be looking
// at, such as a coding agent's task that finished or waits for a decision.
// Messaging channels pass notices on to the owner.
type Notice struct {
	ConversationID string
	// Text is the news, in Markdown.
	Text string
	// Approvals wait for the owner's decision in the conversation.
	Approvals []PendingApproval
	// Channel is the messaging app whose message led to the news, whose
	// reply already says it; empty when none did.
	Channel string
}

// notices are the functions Notify calls.
type notices struct {
	mu   sync.Mutex
	next int
	fns  map[int]func(Notice)
}

// Notices calls fn with each later notice until cancel is called. fn must not
// block.
func (s *ConversationService) Notices(fn func(Notice)) (cancel func()) {
	n := &s.notices
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.fns == nil {
		n.fns = map[int]func(Notice){}
	}
	n.next++
	id := n.next
	n.fns[id] = fn
	return func() {
		n.mu.Lock()
		delete(n.fns, id)
		n.mu.Unlock()
	}
}

// Notify passes notice on to everyone listening for notices. Nobody may be:
// notices are best effort, and the conversation keeps what they say.
func (s *ConversationService) Notify(notice Notice) {
	n := &s.notices
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, fn := range n.fns {
		fn(notice)
	}
}
