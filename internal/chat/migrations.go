package chat

import "fmt"

// Version zero includes existing installations with an unversioned schema.
var migrations = []string{
	`CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, state TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, parts TEXT NOT NULL,
 status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 message_id TEXT NOT NULL REFERENCES messages(id), tool_call_id TEXT NOT NULL, input TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), fact TEXT NOT NULL);
`,
	`ALTER TABLE deliveries ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;`,
	// Models are chosen per conversation; keys live in providers.json.
	`ALTER TABLE conversations ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN usage TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT '';
DELETE FROM settings WHERE key IN ('api_key','api_key_origin');`,
}

func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > len(migrations) {
		return fmt.Errorf("database version %d is newer than this application", version)
	}
	for version < len(migrations) {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err = tx.Exec(migrations[version]); err == nil {
			_, err = tx.Exec(fmt.Sprintf("PRAGMA user_version=%d", version+1))
		}
		if err != nil {
			_ = tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		version++
	}
	return nil
}
