import { eq, inArray } from 'drizzle-orm';
import type { MemoryStore, StoredMemory } from '../../memory/memory';
import { memories } from './schema';
import type { StoreDb } from './db';

/** `layer`/`source` arrive as TEXT; tighten to the domain unions. */
const mapRow = (row: typeof memories.$inferSelect): StoredMemory => ({
	...row,
	layer: row.layer as StoredMemory['layer'],
	source: row.source as StoredMemory['source'],
});

export function createMemoryStore(db: StoreDb): MemoryStore {
	// Long-term memory (docs/adr/0015): source of truth for memory text
	// and the id registry Vectorize deletes need. Survives /clear; wiped by /forget.
	// Lifecycle columns (docs/adr/0038): `layer` working|knowledge, `source`
	// explicit|extracted, `confirmations`, `last_seen_ts`.
	return {
		insert: (values) => {
			db.insert(memories)
				.values(values)
				.onConflictDoUpdate({
					target: memories.id,
					set: values,
				})
				.run();
		},
		// drizzle's `set` accepts a partial — no read-merge-replace needed.
		update: (id, fields) => {
			db.update(memories).set(fields).where(eq(memories.id, id)).run();
		},
		listIds: () => db.select({ id: memories.id }).from(memories).all().map((row) => row.id),
		listAll: () => db.select().from(memories).all().map(mapRow),
		getByIds: (ids) => {
			if (ids.length === 0) return [];
			return db.select().from(memories).where(inArray(memories.id, ids)).all().map(mapRow);
		},
		deleteByIds: (ids) => {
			if (ids.length === 0) return;
			db.delete(memories).where(inArray(memories.id, ids)).run();
		},
		deleteAll: () => {
			db.delete(memories).run();
		},
	};
}
