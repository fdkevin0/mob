/**
 * The **Memory** module (PRD #72, docs/adr/0015, docs/adr/0038) — owns
 * **Long-term memory** over three injected interfaces, mirroring the
 * **EmailReply module** (ADR-0013, unpublished). The Conversation Agent constructs it with
 * concrete deps (a DO-SQLite-backed store, a Vectorize-backed index, a Workers-AI
 * embed); tests substitute three fakes and need no Durable Object.
 *
 * One store, two layers (docs/adr/0038): a fact's `layer` is a lifecycle state —
 * `working` facts enter via **Fact extraction** and must earn permanence through
 * confirmations; `knowledge` facts are durable (explicit `remember`, or a working
 * fact promoted at `PROMOTION_CONFIRMATIONS`). Promotion is a metadata update,
 * never a copy.
 */

/** Lifecycle layer of a fact — a state, not a separate store (docs/adr/0038). */
export type MemoryLayer = 'working' | 'knowledge';

/** How a fact entered memory: the explicit `remember` tool or Fact extraction. */
export type MemorySource = 'explicit' | 'extracted';

/** A stored memory — the source of truth lives in the per-chat DO SQLite mirror. */
export interface StoredMemory {
	id: string;
	text: string;
	ts: number;
	layer: MemoryLayer;
	source: MemorySource;
	confirmations: number;
	lastSeenTs: number;
}

/** The DO-SQLite mirror: the source of truth and the id registry for deletes. */
export interface MemoryStore {
	insert(memory: StoredMemory): void;
	/** Update a fact's lifecycle fields (and text on supersede) in place. */
	update(id: string, fields: { text?: string; layer?: MemoryLayer; confirmations?: number; lastSeenTs?: number }): void;
	listIds(): string[];
	listAll(): StoredMemory[];
	getByIds(ids: string[]): StoredMemory[];
	deleteByIds(ids: string[]): void;
	deleteAll(): void;
}

/** One Vectorize match: an id and its similarity score. */
export interface VectorMatch {
	id: string;
	score: number;
}

/** The Vectorize ANN index — vectors carry `{ chatId }` metadata for filtering. */
export interface VectorIndex {
	upsert(id: string, values: number[], metadata: Record<string, unknown>): Promise<void>;
	query(values: number[], options: { topK: number; filter: Record<string, unknown> }): Promise<VectorMatch[]>;
	deleteByIds(ids: string[]): Promise<void>;
}

/** Embed text into a vector (Workers AI `@cf/baai/bge-m3` in production). */
export type Embed = (text: string) => Promise<number[]>;

/** A recalled fact and the similarity score it matched at. */
export interface RecallHit {
	text: string;
	score: number;
}

/** An auto-recalled fact with the timestamps the prompt preamble shows. */
export interface AutoRecallHit extends RecallHit {
	ts: number;
	lastSeenTs: number;
}

/** What `ingestFact` did with one candidate fact (docs/adr/0038). */
export type IngestOutcome =
	| { action: 'inserted'; id: string }
	| { action: 'confirmed'; id: string; superseded: boolean; promoted: boolean };

// Tunable constants (docs/adr/0038): revisit with real usage; deliberately not settings.
/** Nearest-neighbor similarity at or above which an extracted fact confirms an existing one. */
export const DEDUP_THRESHOLD = 0.85;
/** Confirmations at which a working fact is promoted to the knowledge layer. */
export const PROMOTION_CONFIRMATIONS = 3;
/** Working facts neither confirmed nor promoted within this window are pruned. */
export const DECAY_MS = 30 * 24 * 60 * 60 * 1000;
/** Auto-recall drops matches below this similarity so quiet chats inject nothing. */
export const AUTO_RECALL_MIN_SCORE = 0.55;
/** Auto-recall skips trivially short user messages (chars, trimmed). */
export const AUTO_RECALL_MIN_QUERY_LENGTH = 6;

/**
 * Format auto-recalled facts as the turn's user-message preamble (docs/adr/0038):
 * injected at the volatile prompt tail, never persisted to history — the Session
 * stores the raw user text, so retrieved facts can't feed back into compaction.
 * Dates let the model weigh freshness itself.
 */
export function formatRecallPreamble(hits: AutoRecallHit[]): string {
	const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
	const lines = hits.map((hit) =>
		hit.lastSeenTs > hit.ts
			? `- ${hit.text} (noted ${day(hit.ts)}, last seen ${day(hit.lastSeenTs)})`
			: `- ${hit.text} (noted ${day(hit.ts)})`
	);
	return `[Recalled from long-term memory — may be outdated; weigh by date:]\n${lines.join('\n')}`;
}

export interface MemoryDeps {
	chatId: number;
	store: MemoryStore;
	index: VectorIndex;
	embed: Embed;
	/** Defaults to `crypto.randomUUID`. */
	generateId?: () => string;
	/** Defaults to `Date.now`. */
	now?: () => number;
	/** Recall match count. Defaults to 5. */
	topK?: number;
}

export class Memory {
	private readonly chatId: number;
	private readonly store: MemoryStore;
	private readonly index: VectorIndex;
	private readonly embed: Embed;
	private readonly generateId: () => string;
	private readonly now: () => number;
	private readonly topK: number;

	constructor(deps: MemoryDeps) {
		this.chatId = deps.chatId;
		this.store = deps.store;
		this.index = deps.index;
		this.embed = deps.embed;
		this.generateId = deps.generateId ?? (() => crypto.randomUUID());
		this.now = deps.now ?? (() => Date.now());
		this.topK = deps.topK ?? 5;
	}

	private async matchingRows(query: string, minScore = -Infinity): Promise<Array<{ row: StoredMemory; score: number }>> {
		const values = await this.embed(query);
		const matches = (await this.index.query(values, { topK: this.topK, filter: { chatId: this.chatId } }))
			.filter((match) => match.score >= minScore);
		const byId = new Map(this.store.getByIds(matches.map((match) => match.id)).map((row) => [row.id, row]));
		return matches.flatMap((match) => {
			const row = byId.get(match.id);
			return row ? [{ row, score: match.score }] : [];
		});
	}

	/**
	 * Save a fact explicitly: straight to the knowledge layer — explicit intent
	 * skips Working Memory's confirmation ladder (docs/adr/0038). Mirror first
	 * (source of truth), then the vector.
	 */
	async remember(fact: string): Promise<{ id: string }> {
		const id = this.generateId();
		const ts = this.now();
		this.store.insert({ id, text: fact, ts, layer: 'knowledge', source: 'explicit', confirmations: 1, lastSeenTs: ts });
		const values = await this.embed(fact);
		await this.index.upsert(id, values, { chatId: this.chatId });
		return { id };
	}

	/** Retrieve the top-k facts for a query within this chat, joined back to text. */
	async recall(query: string): Promise<RecallHit[]> {
		return (await this.matchingRows(query)).map(({ row, score }) => ({ text: row.text, score }));
	}

	/**
	 * **Auto-recall** (docs/adr/0038): the per-turn retrieval pipeline. Embeds the
	 * user message, queries both layers chat-filtered, and keeps only matches at
	 * or above `AUTO_RECALL_MIN_SCORE`. Returns `[]` for trivially short messages
	 * without paying for an embedding.
	 */
	async autoRecall(userText: string): Promise<AutoRecallHit[]> {
		if (userText.trim().length < AUTO_RECALL_MIN_QUERY_LENGTH) return [];
		return (await this.matchingRows(userText, AUTO_RECALL_MIN_SCORE)).map(({ row, score }) => ({
			text: row.text,
			score,
			ts: row.ts,
			lastSeenTs: row.lastSeenTs,
		}));
	}

	/**
	 * **Fact extraction**'s write path (docs/adr/0038): dedup-by-similarity *is*
	 * the confirmation counter. Nearest neighbor at/above `DEDUP_THRESHOLD` →
	 * confirm it (bump `confirmations`, refresh `lastSeenTs`; different wording
	 * **supersedes** the text and vector, keeping id and count; a working fact
	 * reaching `PROMOTION_CONFIRMATIONS` is promoted). Otherwise insert a new
	 * working fact with `confirmations = 1`.
	 */
	async ingestFact(fact: string): Promise<IngestOutcome> {
		const values = await this.embed(fact);
		const matches = await this.index.query(values, { topK: 1, filter: { chatId: this.chatId } });
		const nearest = matches[0];
		const existing = nearest && nearest.score >= DEDUP_THRESHOLD ? this.store.getByIds([nearest.id])[0] : undefined;

		if (existing) {
			const confirmations = existing.confirmations + 1;
			const promoted = existing.layer === 'working' && confirmations >= PROMOTION_CONFIRMATIONS;
			const superseded = existing.text !== fact;
			this.store.update(existing.id, {
				confirmations,
				lastSeenTs: this.now(),
				...(promoted ? { layer: 'knowledge' as const } : {}),
				...(superseded ? { text: fact } : {}),
			});
			// Newest wording wins: re-point the existing vector at the new text.
			if (superseded) await this.index.upsert(existing.id, values, { chatId: this.chatId });
			return { action: 'confirmed', id: existing.id, superseded, promoted };
		}

		const id = this.generateId();
		const ts = this.now();
		this.store.insert({ id, text: fact, ts, layer: 'working', source: 'extracted', confirmations: 1, lastSeenTs: ts });
		await this.index.upsert(id, values, { chatId: this.chatId });
		return { action: 'inserted', id };
	}

	/**
	 * Decay (docs/adr/0038): prune working facts whose `lastSeenTs` fell outside
	 * `DECAY_MS` — never re-confirmed, never promoted, quietly dropped. Knowledge
	 * facts never auto-expire. Runs at each extraction pass.
	 */
	async decay(): Promise<{ pruned: number }> {
		const cutoff = this.now() - DECAY_MS;
		const stale = this.store
			.listAll()
			.filter((row) => row.layer === 'working' && row.lastSeenTs < cutoff)
			.map((row) => row.id);
		if (stale.length === 0) return { pruned: 0 };
		await this.index.deleteByIds(stale);
		this.store.deleteByIds(stale);
		return { pruned: stale.length };
	}

	/** All facts, newest first — the Mini App Memory tab's list (docs/adr/0038). */
	list(): StoredMemory[] {
		return this.store.listAll().sort((a, b) => b.ts - a.ts);
	}

	/** Wipe this chat's memories — both layers — from the index (by id) then the mirror. */
	async forget(): Promise<{ count: number }> {
		const ids = this.store.listIds();
		if (ids.length > 0) await this.index.deleteByIds(ids);
		this.store.deleteAll();
		return { count: ids.length };
	}
}
