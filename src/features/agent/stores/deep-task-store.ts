import { eq } from 'drizzle-orm';
import type { DeepTaskStore, StoredDeepTask } from '../deep-tasks';
import { deepTask } from './schema';
import type { StoreDb } from './db';

const map = (row: typeof deepTask.$inferSelect): StoredDeepTask => ({
	id: row.taskId,
	description: row.description,
	prompt: row.prompt,
	startedBy: row.startedBy,
	startedAt: row.startedAt,
	status: row.status === 'cancelling' ? 'cancelling' : 'running',
	stepsDone: row.stepsDone,
	phase: row.phase,
	startMessageId: row.startMessageId,
});

/** One pinned task per chat; cleared after delivery. */
export function createDeepTaskStore(db: StoreDb): DeepTaskStore {
	// The Deep task slot (docs/adr/0040): one background run per chat at a time,
	// a pinned row like `email_reply`. Cleared when the delivery lands.
	return {
		get: () => {
			const row = db.select().from(deepTask).where(eq(deepTask.id, 1)).get();
			return row ? map(row) : null;
		},
		put: (task) => {
			const values = {
				id: 1,
				taskId: task.id,
				description: task.description,
				prompt: task.prompt,
				startedBy: task.startedBy,
				startedAt: task.startedAt,
				status: task.status,
				stepsDone: task.stepsDone,
				phase: task.phase,
				startMessageId: task.startMessageId,
			};
			db.insert(deepTask)
				.values(values)
				.onConflictDoUpdate({
					target: deepTask.id,
					set: values,
				})
				.run();
		},
		clear: () => {
			db.delete(deepTask).run();
		},
	};
}
