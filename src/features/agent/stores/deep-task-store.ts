import { eq } from 'drizzle-orm';
import type { DeepTaskStore, StoredDeepTask } from '../deep-tasks';
import { deepTask } from './schema';
import type { StoreDb } from './db';

const map = ({ id: _id, taskId, ...row }: typeof deepTask.$inferSelect): StoredDeepTask => ({
	...row,
	id: taskId,
	status: row.status === 'cancelling' ? 'cancelling' : 'running',
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
			const { id, ...fields } = task;
			const values = { id: 1, taskId: id, ...fields };
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
