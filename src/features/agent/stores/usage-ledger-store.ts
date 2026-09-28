import { gte, sql } from 'drizzle-orm';
import type { UsageLedgerStore, UsageRow } from '../usage-ledger';
import { usageLedger } from './schema';
import type { StoreDb } from './db';

/** @see conversation-agent.ts `usageLedgerStore` getter */
export function createUsageLedgerStore(db: StoreDb): UsageLedgerStore {
	// The Usage ledger (PRD #100): bounded daily token aggregates per
	// (day, user, kind, model) — the SandboxUsage shape applied to tokens.
	return {
		accumulate: (row) => {
			db.insert(usageLedger)
				.values({
					day: row.day,
					userId: row.userId,
					kind: row.kind,
					model: row.model,
					inputTokens: row.inputTokens,
					outputTokens: row.outputTokens,
					cacheReadTokens: row.cacheReadTokens,
					reasoningTokens: row.reasoningTokens,
				})
				.onConflictDoUpdate({
					target: [usageLedger.day, usageLedger.userId, usageLedger.kind, usageLedger.model],
					set: {
						inputTokens: sql`${usageLedger.inputTokens} + excluded.input_tokens`,
						outputTokens: sql`${usageLedger.outputTokens} + excluded.output_tokens`,
						cacheReadTokens: sql`${usageLedger.cacheReadTokens} + excluded.cache_read_tokens`,
						reasoningTokens: sql`${usageLedger.reasoningTokens} + excluded.reasoning_tokens`,
					},
				})
				.run();
		},
		listSince: (sinceDay) =>
			db
				.select()
				.from(usageLedger)
				.where(gte(usageLedger.day, sinceDay))
				.all()
				.map((row): UsageRow => ({
					day: row.day,
					userId: row.userId,
					kind: row.kind as UsageRow['kind'],
					model: row.model,
					inputTokens: row.inputTokens,
					outputTokens: row.outputTokens,
					cacheReadTokens: row.cacheReadTokens,
					reasoningTokens: row.reasoningTokens,
				})),
	};
}
