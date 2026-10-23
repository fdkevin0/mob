package chat

import "sync"

// Change says what a write changed, so a client reloads only that: a
// conversation (its messages, model or whether a turn runs), the conversation
// list (a title, order or new conversation), or the task tree.
type Change struct {
	Seq          uint64 `json:"seq"`
	Conversation string `json:"conversation,omitempty"`
	List         bool   `json:"list,omitempty"`
	Tasks        bool   `json:"tasks,omitempty"`
}

// changeBuffer is how many changes a subscriber may fall behind before it is
// dropped; a dropped client reconnects and reloads everything.
const changeBuffer = 256

// Changes tells subscribers about store writes as they happen. It holds no
// history: a client reloads what it shows whenever it (re)subscribes.
type Changes struct {
	mu   sync.Mutex
	seq  uint64
	subs map[chan Change]struct{}
}

// Subscribe returns the changes from now on and a function that ends the
// subscription. The channel closes when the subscriber fell behind.
func (c *Changes) Subscribe() (<-chan Change, func()) {
	ch := make(chan Change, changeBuffer)
	c.mu.Lock()
	if c.subs == nil {
		c.subs = map[chan Change]struct{}{}
	}
	c.subs[ch] = struct{}{}
	c.mu.Unlock()
	return ch, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if _, ok := c.subs[ch]; ok {
			delete(c.subs, ch)
			close(ch)
		}
	}
}

// watched reports whether anyone subscribes, so writes skip finding out what
// they changed when no one would hear it.
func (c *Changes) watched() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.subs) > 0
}

func (c *Changes) publish(change Change) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	change.Seq = c.seq
	for ch := range c.subs {
		select {
		case ch <- change:
		default:
			delete(c.subs, ch)
			close(ch)
		}
	}
}

// conversation publishes a change to conversation id; list also when the
// conversation list changed.
func (c *Changes) conversation(id string, list bool) {
	if id != "" {
		c.publish(Change{Conversation: id, List: list})
	}
}

func (c *Changes) tasks() { c.publish(Change{Tasks: true}) }

// messageChanged publishes a change to the conversation of message id.
func (s *Store) messageChanged(id string) {
	if !s.Changes.watched() {
		return
	}
	var conversation string
	if s.db.QueryRow("SELECT conversation_id FROM messages WHERE id=?", id).Scan(&conversation) == nil {
		s.Changes.conversation(conversation, false)
	}
}
