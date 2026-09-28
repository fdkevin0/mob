/**
 * **Fact extraction** (docs/adr/0038): one LLM call per compaction — an
 * *extraction run* — that mines a compaction summary for durable facts and feeds
 * them through `Memory.ingestFact` (dedup/confirm/promote), then runs decay in
 * the same pass. Pure module + injected deps, mirroring the Memory module: the
 * Conversation Agent binds `generate` to the chat's model; tests pass a stub.
 *
 * Plain-line output, not JSON: configured providers can have uneven structured-
 * output support, and fact quality doesn't need a schema.
 */

export interface ExtractionDeps {
	/** Run the extraction prompt against the chat's model, returning raw text. */
	generate: (prompt: string) => Promise<string>;
	/** `Memory.ingestFact` — dedup-by-similarity confirm-or-insert. */
	ingest: (fact: string) => Promise<unknown>;
	/** `Memory.decay` — prune stale working facts in the same pass. */
	decay: () => Promise<{ pruned: number }>;
	/** Cap on facts ingested per run. Defaults to 10. */
	maxFacts?: number;
}

export interface ExtractionResult {
	facts: string[];
	pruned: number;
}

const EXTRACTION_PROMPT = `You extract durable facts about the user from a conversation summary.

Rules:
- Output one fact per line, no numbering, no bullets, no commentary.
- Keep only facts worth remembering across future conversations: stable preferences, personal or project details, decisions, ongoing situations.
- Ignore chit-chat, one-off requests, and anything about the assistant itself.
- Phrase each fact as a short standalone sentence about the user, in the summary's language.
- If there is nothing worth remembering, output exactly: NONE

Summary:
`;

/** Parse the model's plain-line output into candidate facts. */
export function parseFacts(raw: string, maxFacts: number): string[] {
	const lines = raw
		.split('\n')
		.map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
		.filter((line) => line.length > 0);
	if (lines.length === 1 && lines[0].toUpperCase() === 'NONE') return [];
	return lines.filter((line) => line.toUpperCase() !== 'NONE').slice(0, maxFacts);
}

/**
 * One extraction run: generate candidates from the summary, ingest each (a
 * failed ingest skips that fact, never the run), then decay. Callers treat the
 * whole run as best-effort — it must never fail the compaction that hosted it.
 */
export async function runExtraction(summary: string, deps: ExtractionDeps): Promise<ExtractionResult> {
	const maxFacts = deps.maxFacts ?? 10;
	const raw = await deps.generate(EXTRACTION_PROMPT + summary);
	const facts = parseFacts(raw, maxFacts);
	for (const fact of facts) {
		await deps.ingest(fact);
	}
	const { pruned } = await deps.decay();
	return { facts, pruned };
}
