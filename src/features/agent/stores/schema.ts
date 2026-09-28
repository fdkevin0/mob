/** Drizzle query types for agent tables. Bootstrap DDL and in-place migrations live in db.ts; keep column definitions aligned. */
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const memories = sqliteTable('memories', {
	id: text('id').primaryKey(),
	text: text('text').notNull(),
	ts: integer('ts').notNull(),
	layer: text('layer').notNull().default('knowledge'),
	source: text('source').notNull().default('explicit'),
	confirmations: integer('confirmations').notNull().default(1),
	lastSeenTs: integer('last_seen_ts').notNull().default(0),
});

export const deepTask = sqliteTable(
	'deep_task',
	{
		id: integer('id').primaryKey(),
		taskId: text('task_id').notNull(),
		description: text('description').notNull(),
		prompt: text('prompt').notNull(),
		startedBy: integer('started_by').notNull(),
		startedAt: integer('started_at').notNull(),
		status: text('status').notNull(),
		stepsDone: integer('steps_done').notNull(),
		phase: text('phase'),
		startMessageId: integer('start_message_id'),
	},
	(_t) => [check('deep_task_id_check', sql`id = 1`)]
);

export const pendingApprovals = sqliteTable('pending_approvals', {
	id: text('id').primaryKey(),
	toolName: text('tool_name').notNull(),
	argsJson: text('args_json').notNull(),
	requestedBy: integer('requested_by').notNull(),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
});

export const usageLedger = sqliteTable(
	'usage_ledger',
	{
		day: text('day').notNull(),
		userId: integer('user_id').notNull(),
		kind: text('kind').notNull(),
		model: text('model').notNull(),
		inputTokens: integer('input_tokens').notNull().default(0),
		outputTokens: integer('output_tokens').notNull().default(0),
		cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
		reasoningTokens: integer('reasoning_tokens').notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.day, t.userId, t.kind, t.model] })]
);

export const scheduledTurns = sqliteTable('scheduled_turns', {
	id: text('id').primaryKey(),
	description: text('description').notNull(),
	prompt: text('prompt').notNull(),
	whenKind: text('when_kind').notNull(),
	whenAt: integer('when_at'),
	whenCron: text('when_cron'),
	whenTimezone: text('when_timezone'),
	status: text('status').notNull(),
	lastError: text('last_error'),
	createdAt: integer('created_at').notNull(),
});

export const sandboxUsage = sqliteTable(
	'sandbox_usage',
	{
		userId: integer('user_id').notNull(),
		day: text('day').notNull(),
		usedMs: integer('used_ms').notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.day] })]
);

export const emailReply = sqliteTable(
	'email_reply',
	{
		id: integer('id').primaryKey(),
		emailId: integer('email_id').notNull(),
		toAddr: text('to_addr').notNull(),
		fromAddr: text('from_addr').notNull(),
		subject: text('subject'),
		messageId: text('message_id'),
		references: text('refs'),
		r2Key: text('r2_key').notNull(),
		draft: text('draft'),
		status: text('status').notNull(),
	},
	(_t) => [check('email_reply_id_check', sql`id = 1`)]
);
