/** Shared Drizzle handle and bootstrap DDL for the agent stores. See docs/adr/0047. */
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { sql } from 'drizzle-orm';
import * as storeSchema from './schema';

export type StoreDb = DrizzleSqliteDODatabase<typeof storeSchema>;

export function createStoreDb(storage: DurableObjectStorage): StoreDb {
	return drizzle(storage, { schema: storeSchema });
}

/** Idempotent bootstrap plus in-place memory migration; schema.ts supplies query types, not migrations. */
export function ensureStoreSchema(db: StoreDb): void {
	// The bootstrap DDL mirrors `schema.ts` column-for-column.
	for (const ddl of [
		`CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			ts INTEGER NOT NULL,
			layer TEXT NOT NULL DEFAULT 'knowledge',
			source TEXT NOT NULL DEFAULT 'explicit',
			confirmations INTEGER NOT NULL DEFAULT 1,
			last_seen_ts INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS deep_task (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			task_id TEXT NOT NULL,
			description TEXT NOT NULL,
			prompt TEXT NOT NULL,
			started_by INTEGER NOT NULL,
			started_at INTEGER NOT NULL,
			status TEXT NOT NULL,
			steps_done INTEGER NOT NULL,
			phase TEXT,
			start_message_id INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS pending_approvals (
			id TEXT PRIMARY KEY,
			tool_name TEXT NOT NULL,
			args_json TEXT NOT NULL,
			requested_by INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS usage_ledger (
			day TEXT NOT NULL,
			user_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			model TEXT NOT NULL,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_tokens INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (day, user_id, kind, model)
		)`,
		`CREATE TABLE IF NOT EXISTS scheduled_turns (
			id TEXT PRIMARY KEY,
			description TEXT NOT NULL,
			prompt TEXT NOT NULL,
			when_kind TEXT NOT NULL,
			when_at INTEGER,
			when_cron TEXT,
			when_timezone TEXT,
			status TEXT NOT NULL,
			last_error TEXT,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sandbox_usage (
			user_id INTEGER NOT NULL,
			day TEXT NOT NULL,
			used_ms INTEGER NOT NULL,
			PRIMARY KEY (user_id, day)
		)`,
		`CREATE TABLE IF NOT EXISTS email_reply (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			email_id INTEGER NOT NULL,
			to_addr TEXT NOT NULL,
			from_addr TEXT NOT NULL,
			subject TEXT,
			message_id TEXT,
			refs TEXT,
			r2_key TEXT NOT NULL,
			draft TEXT,
			status TEXT NOT NULL
		)`,
	]) {
		db.run(sql.raw(ddl));
	}
	// Migrate a pre-0038 table in place. Backfill as knowledge/explicit: every
	// pre-existing row came from the explicit `remember` tool.
	const memoryColumns = new Set(db.all(sql`SELECT name FROM pragma_table_info('memories')`).map((row) => (row as { name: string }).name));
	if (!memoryColumns.has('layer')) {
		db.run(sql`ALTER TABLE memories ADD COLUMN layer TEXT NOT NULL DEFAULT 'knowledge'`);
		db.run(sql`ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit'`);
		db.run(sql`ALTER TABLE memories ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 1`);
		db.run(sql`ALTER TABLE memories ADD COLUMN last_seen_ts INTEGER NOT NULL DEFAULT 0`);
	}
	db.run(sql`UPDATE memories SET last_seen_ts = ts WHERE last_seen_ts = 0`);
}
