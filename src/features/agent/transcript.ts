/**
 * The **Transcript** rendering helpers (docs/adr/0021). Pure and offline-testable:
 * the single source of truth for how a tool call reads as one line — used both for
 * the chat **Tool message** (sent then edited in place behind the Reply surface)
 * and for the **flattened transcript** persisted as the assistant turn in the
 * **Conversation context**. Display and context are the same information in two
 * renderings, so they share `toolLine`.
 */

/** Max length of a tool summary / short error before it is truncated (~one line). */
export const TOOL_DETAIL_LIMIT = 100;

/** Truncate to `max` chars with a trailing ellipsis, so a summary stays one line. */
export function truncate(text: string, max: number = TOOL_DETAIL_LIMIT): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return trimmed.slice(0, max - 1).trimEnd() + '…';
}

/** Coerce an arbitrary thrown tool error into a short string. */
export function stringifyToolError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * The outcome of a finished tool call (docs/adr/0021, 0026): an optional
 * input-derived `label` (the same one shown live), then either a (possibly empty)
 * output `summary` or an `error`, and an optional `durationMs`. `durationMs` is a
 * live-display affordance only — it is passed to the chat Tool message but **never**
 * stored on a `TranscriptPart`, so the persisted/flattened context omits it.
 */
export type ToolOutcome =
	| { label?: string; summary?: string; durationMs?: number }
	| { label?: string; error: string; durationMs?: number };

/** Render a tool's elapsed time: sub-second as `840ms`, else one-decimal `1.2s` (docs/adr/0026). */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The one-line rendering of a finished tool call (docs/adr/0021, 0026). Composes the
 * available `·`-joined parts after the status emoji:
 * - failed → `⚠️ name · <label> · failed: <short error> · <duration>` (always detailed)
 * - succeeded → `✅ name · <label> · <summary> · <duration>` (any of label/summary/duration may be absent)
 * A bare success with nothing to add is just `✅ name`. The `label`/`summary`/`error`
 * strings are truncated to one line. This is the text the chat Tool message is edited
 * to, and (prefixed with `> `, and without a duration) the context blockquote.
 */
export function toolLine(name: string, outcome: ToolOutcome): string {
	const label = outcome.label?.trim();
	const duration = outcome.durationMs !== undefined ? formatDuration(outcome.durationMs) : undefined;
	const parts: string[] = [name];
	if (label) parts.push(truncate(label));
	if ('error' in outcome) {
		parts.push(`failed: ${truncate(outcome.error)}`);
		if (duration) parts.push(duration);
		return `⚠️ ${parts.join(' · ')}`;
	}
	const summary = outcome.summary?.trim();
	if (summary) parts.push(truncate(summary));
	if (duration) parts.push(duration);
	return `✅ ${parts.join(' · ')}`;
}

/**
 * The initial (in-progress) chat text for a tool message, before its result lands
 * (docs/adr/0026): the wrench plus the input-derived `label` when present, so the
 * user sees *what* is running immediately (`🔧 web_search · cats`).
 */
export function toolStartLine(name: string, label?: string): string {
	const l = label?.trim();
	return l ? `🔧 ${name} · ${truncate(l)}` : `🔧 ${name}`;
}

/** One ordered piece of a turn's transcript: a text segment or a finished tool call. */
export type TranscriptPart =
	| { kind: 'text'; text: string }
	| { kind: 'tool'; name: string; outcome: ToolOutcome };

/**
 * Flatten an ordered transcript into the markdown persisted as the assistant turn
 * (docs/adr/0021): each text segment as prose, each tool call as a `> <toolLine>`
 * blockquote, joined by blank lines so the model recalls *what it already did*.
 * Raw args/results are never included — only the light summary (the Debug trace,
 * ADR-0011, keeps full fidelity). With `interrupted`, a `> ⚠️ turn interrupted`
 * marker is appended so a partial turn reads as unfinished.
 */
export function flattenTranscript(parts: TranscriptPart[], opts: { interrupted?: boolean } = {}): string {
	const lines: string[] = [];
	for (const part of parts) {
		if (part.kind === 'text') {
			const text = part.text.trim();
			if (text) lines.push(text);
		} else {
			lines.push(`> ${toolLine(part.name, part.outcome)}`);
		}
	}
	if (opts.interrupted) lines.push('> ⚠️ turn interrupted');
	return lines.join('\n\n');
}
