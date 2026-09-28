import { eq } from 'drizzle-orm';
import type { ScheduledTurnStore, StoredScheduledTurn } from '../scheduled-turns';
import { scheduledTurns } from './schema';
import type { StoreDb } from './db';

const map = (row: typeof scheduledTurns.$inferSelect): StoredScheduledTurn => ({
	id: row.id,
	description: row.description,
	prompt: row.prompt,
	when:
		row.whenKind === 'once'
			? { kind: 'once', at: row.whenAt as number }
			: { kind: 'recurring', cron: row.whenCron as string, timezone: row.whenTimezone as string },
	status: row.status === 'failed' ? 'failed' : 'active',
	lastError: row.lastError,
	createdAt: row.createdAt,
});

export function createScheduledTurnStore(db: StoreDb): ScheduledTurnStore {
	// Store only the time fields selected by when.kind; preserve failures for the Mini App.
	return {
		upsert: (t) => {
			const values = {
				id: t.id,
				description: t.description,
				prompt: t.prompt,
				whenKind: t.when.kind,
				whenAt: t.when.kind === 'once' ? t.when.at : null,
				whenCron: t.when.kind === 'recurring' ? t.when.cron : null,
				whenTimezone: t.when.kind === 'recurring' ? t.when.timezone : null,
				status: t.status,
				lastError: t.lastError,
				createdAt: t.createdAt,
			};
			db.insert(scheduledTurns)
				.values(values)
				.onConflictDoUpdate({
					target: scheduledTurns.id,
					set: values,
				})
				.run();
		},
		getById: (id) => {
			const row = db.select().from(scheduledTurns).where(eq(scheduledTurns.id, id)).get();
			return row ? map(row) : null;
		},
		list: () => db.select().from(scheduledTurns).all().map(map),
		deleteById: (id) => {
			db.delete(scheduledTurns).where(eq(scheduledTurns.id, id)).run();
		},
	};
}
