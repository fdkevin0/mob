// The database schema. PRAGMA user_version records it; the meta table records
// the release that last opened the database. Version 12 is the schema the Go
// service left, so its databases open as they are; upgrades lists how each
// older schema becomes the next.
export const schemaVersion = 14;

/** upgrades are the statements that bring schema N-1 to N, by N. */
export const upgrades: Record<number, string> = {
	// Tasks that only read another task's worktree, such as reviewers.
	11: "ALTER TABLE tasks ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;",
	// How an agent said its work ended.
	12: "ALTER TABLE tasks ADD COLUMN outcome TEXT NOT NULL DEFAULT ''; ALTER TABLE tasks ADD COLUMN result TEXT NOT NULL DEFAULT '';",
	// How long a reply took, and how soon each model request's first words came.
	13: "ALTER TABLE messages ADD COLUMN stats TEXT NOT NULL DEFAULT ''; ALTER TABLE usage ADD COLUMN first_token_ms INTEGER NOT NULL DEFAULT 0;",
	// Where a task is in its blueprint.
	14: "ALTER TABLE tasks ADD COLUMN flow TEXT NOT NULL DEFAULT '';",
};

export const schema = `CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, state TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL,
 model TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', summary_through TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, parts TEXT NOT NULL,
 status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL DEFAULT '', stats TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 message_id TEXT NOT NULL REFERENCES messages(id), tool_call_id TEXT NOT NULL, input TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), fact TEXT NOT NULL,
 owner INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tool TEXT NOT NULL,
 scope TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(conversation_id, tool, scope));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversation_id TEXT UNIQUE NOT NULL REFERENCES conversations(id),
 project TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT NOT NULL,
 session TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 parent_id TEXT NOT NULL DEFAULT '', read_only INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
 flow TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS usage(seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
 model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cache_read INTEGER NOT NULL,
 cache_write INTEGER NOT NULL, cost REAL NOT NULL, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL,
 session TEXT NOT NULL DEFAULT '', first_token_ms INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS usage_conversation ON usage(conversation_id, model);
CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 prompt TEXT NOT NULL, next INTEGER NOT NULL, repeat TEXT NOT NULL DEFAULT '', zone TEXT NOT NULL DEFAULT '', clock TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/** SchemaError explains why this release cannot open a database. */
export class SchemaError extends Error {}
