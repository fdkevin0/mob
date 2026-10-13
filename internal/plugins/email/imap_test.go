package email

import (
	"sync"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/backend"
)

// lockedBackend serializes every call into a backend, so that a test can
// deliver mail through it while an IMAP server reads the same mailbox.
// go-imap's memory backend has no locking of its own.
type lockedBackend struct {
	backend.Backend
	mu *sync.Mutex
}

func newLockedBackend(b backend.Backend) lockedBackend {
	return lockedBackend{b, new(sync.Mutex)}
}

func (b lockedBackend) Login(info *imap.ConnInfo, username, password string) (backend.User, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	u, err := b.Backend.Login(info, username, password)
	if err != nil {
		return nil, err
	}
	return lockedUser{u, b.mu}, nil
}

type lockedUser struct {
	user backend.User
	mu   *sync.Mutex
}

func (u lockedUser) Username() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.user.Username()
}

func (u lockedUser) ListMailboxes(subscribed bool) ([]backend.Mailbox, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	list, err := u.user.ListMailboxes(subscribed)
	for i, m := range list {
		list[i] = lockedMailbox{m, u.mu}
	}
	return list, err
}

func (u lockedUser) GetMailbox(name string) (backend.Mailbox, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	m, err := u.user.GetMailbox(name)
	if err != nil {
		return nil, err
	}
	return lockedMailbox{m, u.mu}, nil
}

func (u lockedUser) CreateMailbox(name string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.user.CreateMailbox(name)
}

func (u lockedUser) DeleteMailbox(name string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.user.DeleteMailbox(name)
}

func (u lockedUser) RenameMailbox(existing, name string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.user.RenameMailbox(existing, name)
}

func (u lockedUser) Logout() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.user.Logout()
}

type lockedMailbox struct {
	mailbox backend.Mailbox
	mu      *sync.Mutex
}

func (m lockedMailbox) Name() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.Name()
}

func (m lockedMailbox) Info() (*imap.MailboxInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.Info()
}

func (m lockedMailbox) Status(items []imap.StatusItem) (*imap.MailboxStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.Status(items)
}

func (m lockedMailbox) SetSubscribed(subscribed bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.SetSubscribed(subscribed)
}

func (m lockedMailbox) Check() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.Check()
}

// ListMessages holds the lock while it sends; the server drains ch on another
// goroutine that does not call back into the backend.
func (m lockedMailbox) ListMessages(uid bool, seqset *imap.SeqSet, items []imap.FetchItem, ch chan<- *imap.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.ListMessages(uid, seqset, items, ch)
}

func (m lockedMailbox) SearchMessages(uid bool, criteria *imap.SearchCriteria) ([]uint32, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.SearchMessages(uid, criteria)
}

func (m lockedMailbox) CreateMessage(flags []string, date time.Time, body imap.Literal) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.CreateMessage(flags, date, body)
}

func (m lockedMailbox) UpdateMessagesFlags(uid bool, seqset *imap.SeqSet, op imap.FlagsOp, flags []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.UpdateMessagesFlags(uid, seqset, op, flags)
}

func (m lockedMailbox) CopyMessages(uid bool, seqset *imap.SeqSet, dest string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.CopyMessages(uid, seqset, dest)
}

func (m lockedMailbox) Expunge() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mailbox.Expunge()
}
