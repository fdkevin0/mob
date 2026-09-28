import type { SqlProvider } from 'agents/context';
import { isReasoningEffort, type ReasoningEffort } from '../ai/reasoning-effort';

/** Default estimated-token threshold for Session compaction. */
const COMPACT_TOKEN_THRESHOLD = 24000;

const DEFAULT_MEMORY_TOP_K = 5;

/** Typed chat settings and defaults. Construction ensures the key/value table exists. */
export class ChatSettings {
	constructor(private agent: SqlProvider) {
		void this.agent.sql`
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`;
	}

	// ── Core CRUD ──────────────────────────────────────────────────────────────

	private getRaw(key: string): string | null {
		const rows = this.agent.sql<{ value: string }>`SELECT value FROM settings WHERE key = ${key}`;
		return rows[0]?.value ?? null;
	}

	private setRaw(key: string, value: string): void {
		void this.agent.sql`
			INSERT INTO settings (key, value) VALUES (${key}, ${value})
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`;
	}

	private remove(key: string): void {
		void this.agent.sql`DELETE FROM settings WHERE key = ${key}`;
	}

	private getPositiveNumber(key: string, fallback: number): number {
		const value = Number(this.getRaw(key));
		return Number.isFinite(value) && value > 0 ? value : fallback;
	}

	private setPositiveNumber(key: string, value: number | null): void {
		if (value === null || !Number.isFinite(value) || value <= 0) this.remove(key);
		else this.setRaw(key, String(Math.round(value)));
	}

	// ── Debug mode (docs/adr/0011) ────────────────────────────────────────────

	get debug(): boolean {
		return this.getRaw('debug') === '1';
	}

	set debug(enabled: boolean) {
		this.setRaw('debug', enabled ? '1' : '0');
	}

	// ── Language preference (docs/adr/0025) ────────────────────────────────────
	// `null` / blank → row deleted (chat uses default: mirror the user's language).

	get language(): string | null {
		return this.getRaw('language');
	}

	set language(value: string | null) {
		const trimmed = value?.trim();
		if (trimmed) {
			this.setRaw('language', trimmed);
		} else {
			this.remove('language');
		}
	}

	// ── HTML→Markdown parser (Chat settings, finding #6) ──────────────────────

	get htmlParser(): 'turndown' | 'ai' {
		const v = this.getRaw('html_parser');
		return v === 'ai' ? 'ai' : 'turndown';
	}

	set htmlParser(parser: 'turndown' | 'ai') {
		this.setRaw('html_parser', parser);
	}

	// ── Reasoning effort (Chat settings, docs/adr/0036) ────────────────────────

	get reasoning(): ReasoningEffort {
		const v = this.getRaw('reasoning');
		return isReasoningEffort(v) ? v : 'default';
	}

	set reasoning(effort: ReasoningEffort) {
		this.setRaw('reasoning', effort);
	}

	// ── Compaction token threshold (Chat settings, docs/adr/0036) ─────────────
	// `null` / non-positive → row deleted → default applied on next read.

	get compactionThreshold(): number {
		return this.getPositiveNumber('compaction_threshold', COMPACT_TOKEN_THRESHOLD);
	}

	set compactionThreshold(tokens: number | null) {
		this.setPositiveNumber('compaction_threshold', tokens);
	}

	// ── Memory retrieval count (Chat settings, docs/adr/0036) ────────────────
	// Like compactionThreshold: `null` / non-positive → delete → default.

	get memoryTopK(): number {
		return this.getPositiveNumber('memory_top_k', DEFAULT_MEMORY_TOP_K);
	}

	set memoryTopK(topK: number | null) {
		this.setPositiveNumber('memory_top_k', topK);
	}
}
