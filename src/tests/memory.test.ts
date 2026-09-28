import { describe, it, expect } from 'vitest';
import {
	AUTO_RECALL_MIN_SCORE,
	DECAY_MS,
	Memory,
	formatRecallPreamble,
	type MemoryStore,
	type StoredMemory,
	type VectorIndex,
	type VectorMatch,
} from '../features/memory/memory';
import { parseFacts, runExtraction } from '../features/memory/extraction';

/** A full StoredMemory row from the pre-lifecycle shorthand tests used. */
function row(partial: { id: string; text: string; ts: number } & Partial<StoredMemory>): StoredMemory {
	return {
		layer: 'knowledge',
		source: 'explicit',
		confirmations: 1,
		lastSeenTs: partial.ts,
		...partial,
	};
}

/** An in-memory MemoryStore standing in for the DO SQLite mirror. */
function fakeStore(seed: StoredMemory[] = []): MemoryStore & { rows: StoredMemory[] } {
	const rows = [...seed];
	return {
		rows,
		insert(memory) {
			rows.push(memory);
		},
		update(id, fields) {
			const target = rows.find((r) => r.id === id);
			if (target) Object.assign(target, fields);
		},
		listIds() {
			return rows.map((r) => r.id);
		},
		listAll() {
			return [...rows];
		},
		getByIds(ids) {
			const want = new Set(ids);
			return rows.filter((r) => want.has(r.id));
		},
		deleteByIds(ids) {
			const drop = new Set(ids);
			for (let i = rows.length - 1; i >= 0; i--) {
				if (drop.has(rows[i].id)) rows.splice(i, 1);
			}
		},
		deleteAll() {
			rows.length = 0;
		},
	};
}

/** A fake VectorIndex recording upserts/queries/deletes. */
function fakeIndex(
	queryResult: VectorMatch[] = []
): VectorIndex & {
	upserts: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>;
	queries: Array<{ values: number[]; topK: number; filter: Record<string, unknown> }>;
	deletes: string[][];
} {
	const upserts: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
	const queries: Array<{ values: number[]; topK: number; filter: Record<string, unknown> }> = [];
	const deletes: string[][] = [];
	return {
		upserts,
		queries,
		deletes,
		async upsert(id, values, metadata) {
			upserts.push({ id, values, metadata });
		},
		async query(values, options) {
			queries.push({ values, ...options });
			return queryResult;
		},
		async deleteByIds(ids) {
			deletes.push(ids);
		},
	};
}

const CHAT_ID = 42;
const NOW = 1000;

function memory(opts: {
	store: MemoryStore;
	index: VectorIndex;
	embed?: (text: string) => Promise<number[]>;
	ids?: string[];
	now?: () => number;
}): Memory {
	const ids = opts.ids ? [...opts.ids] : ['id-1', 'id-2', 'id-3'];
	return new Memory({
		chatId: CHAT_ID,
		store: opts.store,
		index: opts.index,
		embed: opts.embed ?? (async (text) => [text.length, 0, 0]),
		generateId: () => ids.shift() ?? 'overflow',
		now: opts.now ?? (() => NOW),
		topK: 5,
	});
}

/**
 * Drives the Memory module (PRD #72, docs/adr/0015, docs/adr/0038) with a fake
 * store, a fake Vectorize index, and a fake embed — no Durable Object, no
 * Vectorize, no Workers AI. Prior art: `email-reply-module.test.ts`. Asserts the
 * writes, the chatId filter, the id→text join, the dual-delete, and the
 * lifecycle: ingest dedup/confirm/supersede/promote, decay, auto-recall.
 */
describe('Memory.remember', () => {
	it('writes to both stores under the chatId, with embedded values', async () => {
		const store = fakeStore();
		const index = fakeIndex();
		const m = memory({ store, index, ids: ['mem-1'] });

		const { id } = await m.remember('user likes metric units');

		expect(id).toBe('mem-1');
		expect(store.listIds().length === 1 && store.listIds()[0] === 'mem-1').toBe(true);
		expect(index.upserts.length).toBe(1);
		expect(index.upserts[0].id).toBe('mem-1');
		expect((index.upserts[0].metadata as { chatId: number }).chatId).toBe(CHAT_ID);
		expect(index.upserts[0].values.length).toBe(3);
	});

	it('writes the knowledge layer with explicit source + lifecycle defaults (skips the confirmation ladder)', async () => {
		const store = fakeStore();
		const m = memory({ store, index: fakeIndex(), ids: ['mem-1'] });

		await m.remember('user prefers Go');

		const saved = store.rows[0];
		expect(saved.layer).toBe('knowledge');
		expect(saved.source).toBe('explicit');
		expect(saved.confirmations === 1 && saved.lastSeenTs === NOW).toBe(true);
	});
});

describe('Memory.recall', () => {
	it('filters by chatId and joins the text in ranked order', async () => {
		const store = fakeStore([row({ id: 'a', text: 'fact A', ts: 1 }), row({ id: 'b', text: 'fact B', ts: 2 })]);
		const index = fakeIndex([
			{ id: 'b', score: 0.9 },
			{ id: 'a', score: 0.7 },
		]);
		const m = memory({ store, index });

		const hits = await m.recall('what facts?');

		expect(index.queries.length).toBe(1);
		expect(index.queries[0].topK).toBe(5);
		expect((index.queries[0].filter as { chatId: number }).chatId).toBe(CHAT_ID);
		expect(hits.length).toBe(2);
		expect(hits[0].text === 'fact B' && hits[0].score === 0.9).toBe(true);
		expect(hits[1].text).toBe('fact A');
	});

	it('drops matches missing from the store (Vectorize eventual consistency)', async () => {
		// Vectorize can return an id the SQLite mirror no longer has (eventual
		// consistency / partial delete) — recall must drop it, not crash.
		const store = fakeStore([row({ id: 'a', text: 'fact A', ts: 1 })]);
		const index = fakeIndex([
			{ id: 'ghost', score: 0.99 },
			{ id: 'a', score: 0.5 },
		]);
		const m = memory({ store, index });

		const hits = await m.recall('q');

		expect(hits.length === 1 && hits[0].text === 'fact A').toBe(true);
	});

	it('on an empty index returns no hits', async () => {
		const m = memory({ store: fakeStore(), index: fakeIndex([]) });
		const hits = await m.recall('q');
		expect(hits.length).toBe(0);
	});
});

describe('Memory.forget', () => {
	it('deletes from the index first, then the store', async () => {
		const store = fakeStore([row({ id: 'a', text: 'A', ts: 1 }), row({ id: 'b', text: 'B', ts: 2 })]);
		const index = fakeIndex();
		const m = memory({ store, index });

		const { count } = await m.forget();

		expect(count).toBe(2);
		expect(index.deletes.length).toBe(1);
		expect(index.deletes[0].join(',')).toBe('a,b');
		expect(store.listIds().length).toBe(0);
	});

	it('on empty does not call delete', async () => {
		const index = fakeIndex();
		const m = memory({ store: fakeStore(), index });
		const { count } = await m.forget();
		expect(count).toBe(0);
		expect(index.deletes.length).toBe(0);
	});
});

describe('Memory.ingestFact', () => {
	it('inserts a new working-layer fact when no neighbor is above the dedup threshold', async () => {
		const store = fakeStore();
		const index = fakeIndex([{ id: 'far', score: 0.4 }]);
		const m = memory({ store, index, ids: ['new-1'] });

		const outcome = await m.ingestFact('user is interviewing at ByteDance');

		expect(outcome.action).toBe('inserted');
		const saved = store.rows[0];
		expect(saved.layer === 'working' && saved.source === 'extracted').toBe(true);
		expect(saved.confirmations).toBe(1);
		expect(index.upserts.length === 1 && index.upserts[0].id === 'new-1').toBe(true);
	});

	it('confirms a near-duplicate without supersede or new vector', async () => {
		// Same wording at high similarity: confirm only — no supersede, no new vector.
		const existing = row({ id: 'a', text: 'user prefers Go', ts: 1, layer: 'working', source: 'extracted', lastSeenTs: 1 });
		const store = fakeStore([existing]);
		const index = fakeIndex([{ id: 'a', score: 0.95 }]);
		const m = memory({ store, index });

		const outcome = await m.ingestFact('user prefers Go');

		expect(outcome.action === 'confirmed' && !outcome.superseded && !outcome.promoted).toBe(true);
		expect(store.rows[0].confirmations).toBe(2);
		expect(store.rows[0].lastSeenTs).toBe(NOW);
		expect(index.upserts.length).toBe(0);
	});

	it('supersedes at high similarity with different wording — text replaced in place, vector re-pointed, id kept', async () => {
		const existing = row({ id: 'a', text: 'user is interviewing at ByteDance', ts: 1, layer: 'working', source: 'extracted', lastSeenTs: 1 });
		const store = fakeStore([existing]);
		const index = fakeIndex([{ id: 'a', score: 0.9 }]);
		const m = memory({ store, index });

		const outcome = await m.ingestFact('user accepted an offer at ByteDance');

		expect(outcome.action === 'confirmed' && outcome.superseded).toBe(true);
		expect(store.rows[0].id === 'a' && store.rows[0].text === 'user accepted an offer at ByteDance').toBe(true);
		expect(store.rows[0].confirmations).toBe(2);
		expect(index.upserts.length === 1 && index.upserts[0].id === 'a').toBe(true);
	});

	it('promotes at the threshold — metadata update only, no copy', async () => {
		// Third confirmation of a working fact promotes it — a metadata update, no copy.
		const existing = row({ id: 'a', text: 'user prefers Go', ts: 1, layer: 'working', source: 'extracted', confirmations: 2, lastSeenTs: 1 });
		const store = fakeStore([existing]);
		const index = fakeIndex([{ id: 'a', score: 0.95 }]);
		const m = memory({ store, index });

		const outcome = await m.ingestFact('user prefers Go');

		expect(outcome.action === 'confirmed' && outcome.promoted).toBe(true);
		expect(store.rows[0].layer).toBe('knowledge');
		expect(store.rows.length).toBe(1);
	});
});

describe('Memory.decay', () => {
	it('prunes only stale working-layer facts (knowledge is exempt)', async () => {
		const now = DECAY_MS + 5000;
		const store = fakeStore([
			row({ id: 'stale-working', text: 'A', ts: 1, layer: 'working', source: 'extracted', lastSeenTs: 1 }),
			row({ id: 'fresh-working', text: 'B', ts: 1, layer: 'working', source: 'extracted', lastSeenTs: now - 100 }),
			row({ id: 'stale-knowledge', text: 'C', ts: 1, layer: 'knowledge', lastSeenTs: 1 }),
		]);
		const index = fakeIndex();
		const m = memory({ store, index, now: () => now });

		const { pruned } = await m.decay();

		expect(pruned).toBe(1);
		expect(index.deletes.length === 1 && index.deletes[0].join(',') === 'stale-working').toBe(true);
		expect(store.listIds().join(',')).toBe('fresh-working,stale-knowledge');
	});
});

describe('Memory.autoRecall', () => {
	it('skips short messages — no embedding paid for a trivial message', async () => {
		let embeds = 0;
		const m = memory({
			store: fakeStore(),
			index: fakeIndex([{ id: 'a', score: 0.99 }]),
			embed: async () => {
				embeds++;
				return [1, 0, 0];
			},
		});

		const hits = await m.autoRecall('ok');

		expect(hits.length).toBe(0);
		expect(embeds).toBe(0);
	});

	it('applies the score cutoff and joins timestamps for the preamble', async () => {
		const store = fakeStore([
			row({ id: 'a', text: 'fact A', ts: 5, lastSeenTs: 7 }),
			row({ id: 'b', text: 'fact B', ts: 2 }),
		]);
		const index = fakeIndex([
			{ id: 'a', score: 0.8 },
			{ id: 'b', score: AUTO_RECALL_MIN_SCORE - 0.01 },
		]);
		const m = memory({ store, index });

		const hits = await m.autoRecall('tell me about my project plans');

		expect(hits.length).toBe(1);
		expect(hits[0].text === 'fact A' && hits[0].ts === 5 && hits[0].lastSeenTs === 7).toBe(true);
	});
});

describe('Memory.list', () => {
	it('sorts newest first', () => {
		const store = fakeStore([row({ id: 'old', text: 'A', ts: 1 }), row({ id: 'new', text: 'B', ts: 9 })]);
		const m = memory({ store, index: fakeIndex() });
		const all = m.list();
		expect(all[0].id === 'new' && all[1].id === 'old').toBe(true);
	});
});

describe('formatRecallPreamble', () => {
	it('formats noted + last seen dates, and omits last seen when never re-seen', () => {
		const noted = Date.UTC(2026, 5, 12);
		const seen = Date.UTC(2026, 6, 1);
		const preamble = formatRecallPreamble([
			{ text: 'user prefers Go', score: 0.8, ts: noted, lastSeenTs: seen },
			{ text: 'user lives in Lisbon', score: 0.7, ts: noted, lastSeenTs: noted },
		]);
		expect(preamble.includes('- user prefers Go (noted 2026-06-12, last seen 2026-07-01)')).toBe(true);
		expect(preamble.includes('- user lives in Lisbon (noted 2026-06-12)')).toBe(true);
	});
});

describe('parseFacts', () => {
	it('NONE (any case) → no facts; bullets/numbering stripped; maxFacts cap', () => {
		expect(parseFacts('NONE', 10).length).toBe(0);
		expect(parseFacts('  none\n', 10).length).toBe(0);
		const facts = parseFacts('- user prefers Go\n2. user lives in Lisbon\n\n* NONE\n', 10);
		expect(facts.length).toBe(2);
		expect(facts[0] === 'user prefers Go' && facts[1] === 'user lives in Lisbon').toBe(true);
		expect(parseFacts('a\nb\nc', 2).length).toBe(2);
	});
});

describe('runExtraction', () => {
	it('ingests the model-emitted facts and runs decay in the same pass', async () => {
		const ingested: string[] = [];
		let decayed = false;
		const result = await runExtraction('summary text', {
			generate: async (prompt) => {
				expect(prompt.includes('summary text')).toBe(true);
				return 'user prefers Go\nuser lives in Lisbon';
			},
			ingest: async (fact) => {
				ingested.push(fact);
			},
			decay: async () => {
				decayed = true;
				return { pruned: 3 };
			},
		});

		expect(ingested.length).toBe(2);
		expect(decayed && result.pruned === 3).toBe(true);
		expect(result.facts.length).toBe(2);
	});
});