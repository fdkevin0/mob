package chat

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/fdkevin0/mob/internal/version"
)

// The schema version lives in PRAGMA user_version; the meta table records the
// release that last opened the database.
//
// Migrations are kept for one migration window (docs/features/releases.md). Closing a
// window removes its oldest migrations: the baseline is rewritten to create the
// schema they produced, first moves up to that schema, and the last release that
// still had them is appended to retired, so an older database can be upgraded
// with that release before this one.
var history = schemaHistory{
	first: 0,
	steps: []migration{
		// Version zero includes installations from before migrations existed.
		{"20261011", `CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, state TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '');
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
`},
		{"20261011", `ALTER TABLE deliveries ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;`},
		// Models are chosen per conversation; keys live in providers.json.
		{"20261011", `ALTER TABLE conversations ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN usage TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT '';
DELETE FROM settings WHERE key IN ('api_key','api_key_origin');`},
		// Remembered approvals; an empty conversation_id covers every conversation.
		{"20261011", `CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tool TEXT NOT NULL,
 scope TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(conversation_id, tool, scope));`},
		// A summary of a conversation's messages up to summary_through, which
		// models read in their place.
		{"20261012", `ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN summary_through TEXT NOT NULL DEFAULT '';`},
		// Coding agent tasks: each is one conversation an agent answers, working
		// in its own worktree of a project.
		{"20261020", `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversation_id TEXT UNIQUE NOT NULL REFERENCES conversations(id),
 project TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT NOT NULL,
 session TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`},
		// Facts the owner approved are read in every one of the owner's
		// conversations; others stay with the conversation that saved them.
		{"20261020", `ALTER TABLE memories ADD COLUMN owner INTEGER NOT NULL DEFAULT 0;`},
		// What each model request, or each turn of a coding agent, used, for
		// usage statistics; replies saved before it count as one request each,
		// made when their conversation was last updated.
		{"20261020", `CREATE TABLE IF NOT EXISTS usage(seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
 model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cache_read INTEGER NOT NULL,
 cache_write INTEGER NOT NULL, cost REAL NOT NULL, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL,
 session TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS usage_conversation ON usage(conversation_id, model);
INSERT INTO usage(conversation_id,message_id,model,input,output,reasoning,cache_read,cache_write,cost,duration_ms,created_at)
 SELECT m.conversation_id,m.id,m.model,COALESCE(m.usage->>'inputTokens',0),COALESCE(m.usage->>'outputTokens',0),COALESCE(m.usage->>'reasoningTokens',0),
 COALESCE(m.usage->>'cacheReadTokens',0),COALESCE(m.usage->>'cacheWriteTokens',0),COALESCE(m.usage->>'cost',0),0,COALESCE(c.updated_at,0)
 FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE m.usage<>'' ORDER BY m.seq;`},
		// The conversation that started a task, for the tree of who started whom.
		{"20261020", `ALTER TABLE tasks ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';`},
		// Prompts Mob's model runs on its own at a set time, once or repeatedly,
		// in the conversation that scheduled them.
		{"20261020", `CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 prompt TEXT NOT NULL, next INTEGER NOT NULL, repeat TEXT NOT NULL DEFAULT '', zone TEXT NOT NULL DEFAULT '', clock TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL);`},
	},
}

// migration upgrades the schema by one version. Added is the UTC date it was
// written (YYYYMMDD), which starts its migration window.
type migration struct{ Added, SQL string }

// retiredWindow sends databases older than Below to Release, the last release
// whose migrations upgrade them.
type retiredWindow struct {
	Below   int
	Release string
}

type schemaHistory struct {
	// baseline creates schema first in an empty database; empty while first is 0.
	baseline string
	first    int
	steps    []migration
	retired  []retiredWindow
}

func (h schemaHistory) latest() int { return h.first + len(h.steps) }

// SchemaError explains why this release cannot open a database and which
// release to install instead.
type SchemaError struct{ Message string }

func (e *SchemaError) Error() string { return e.Message }

func (s *Store) migrate() error { return history.apply(s.db, version.Current) }

func (h schemaHistory) apply(db *sql.DB, current string) error {
	var schema, tables, meta int
	if err := db.QueryRow("PRAGMA user_version").Scan(&schema); err != nil {
		return err
	}
	if err := db.QueryRow("SELECT count(*) FILTER (WHERE name NOT IN ('meta','sqlite_sequence')), count(*) FILTER (WHERE name = 'meta') FROM sqlite_master WHERE type='table'").Scan(&tables, &meta); err != nil {
		return err
	}
	var opened string
	if meta > 0 {
		if err := db.QueryRow("SELECT value FROM meta WHERE key='service_version'").Scan(&opened); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	lastOpened, newer := "an unknown release", "a newer release"
	if opened != "" {
		lastOpened, newer = "Mob "+opened, "Mob "+opened+" or newer"
	}
	switch {
	case schema > h.latest():
		return &SchemaError{fmt.Sprintf("This database has schema %d, last opened by %s. Mob %s reads schema %d and older; install %s.", schema, lastOpened, current, h.latest(), newer)}
	case tables == 0:
		if err := step(db, h.baseline, h.first); err != nil {
			return err
		}
		schema = h.first
	case schema < h.first:
		release := h.retired[0].Release
		for _, w := range h.retired {
			if schema < w.Below {
				release = w.Release
				break
			}
		}
		return &SchemaError{fmt.Sprintf("This database has schema %d, last opened by %s. Mob %s upgrades schema %d and newer. Install Mob %s from %s, start it once to upgrade the database, then start Mob %s again.", schema, lastOpened, current, h.first, release, version.DownloadURL(release), current)}
	}
	for ; schema < h.latest(); schema++ {
		if err := step(db, h.steps[schema-h.first].SQL, schema+1); err != nil {
			return fmt.Errorf("upgrade database to schema %d: %w", schema+1, err)
		}
	}
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta(key,value) VALUES('service_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, current)
	return err
}

// step runs statements and records the schema they reach in one transaction.
func step(db *sql.DB, statements string, schema int) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	if statements != "" {
		if _, err = tx.Exec(statements); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if _, err = tx.Exec(fmt.Sprintf("PRAGMA user_version=%d", schema)); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
