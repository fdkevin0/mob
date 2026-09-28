/** Surface-neutral turn events replayed by Telegram and web adapters. */
import { flattenTranscript, stringifyToolError, truncate, type TranscriptPart } from './transcript';
import type { AgenticSink } from '../ai/agentic-sink';
import type { DebugTrace } from './debug-trace';

/** One raw delivery event; presentation belongs to each surface adapter. */
export type TurnEvent =
	| { type: 'segment-start' }
	| { type: 'text-delta'; delta: string }
	| { type: 'reasoning-delta'; delta: string }
	| { type: 'segment'; markdown: string; final: boolean }
	| { type: 'tool-start'; toolCallId: string; name: string; label?: string }
	| { type: 'tool-done'; toolCallId: string; summary: string; durationMs: number }
	| { type: 'tool-fail'; toolCallId: string; shortError: string; durationMs: number }
	| { type: 'notice'; text: string }
	| { type: 'document'; trace: DebugTrace };

/** Runs one agentic turn into a sink; injected so the turn driver needs no DO. */
export type TurnRunner = (sink: AgenticSink, trace?: DebugTrace) => Promise<void>;

/** A built-in tool's optional one-line result summary hook (reads output), keyed by tool name. */
export type ToolSummaries = Record<string, (output: unknown) => string>;

/**
 * A built-in tool's optional input-label hook (docs/adr/0026): reads the call's
 * *arguments* to a short live label (`web_search` → the query, `fetch_url` → the
 * domain, `run_code` → the language), keyed by tool name. MCP tools have none.
 */
export type ToolLabels = Record<string, (input: unknown) => string>;

/** The empty-turn / interruption fallback notice text. */
export const NO_REPLY_NOTICE = 'No reply was generated. Please try again.';

/** Stream a turn with one-segment lookahead, then persist its transcript. */
export async function runTurnCore(opts: {
	runTurn: TurnRunner;
	emit: (event: TurnEvent) => void | Promise<void>;
	trace?: DebugTrace;
	summaries?: ToolSummaries;
	labels?: ToolLabels;
	onReply?: (transcript: string) => void | Promise<void>;
	/** Observe a swallowed stream error (used by scheduled turns). */
	onError?: (error: unknown) => void | Promise<void>;
	/** Avoid a second notice when the caller provides its own failure message. */
	suppressErrorNotice?: boolean;
}): Promise<void> {
	const { runTurn, emit, trace, summaries = {}, labels = {}, onReply, onError, suppressErrorNotice } = opts;

	// The ordered transcript, accumulated for persistence (display↔memory parity).
	const parts: TranscriptPart[] = [];
	// Tool calls awaiting their result, correlated by `toolCallId`. `label` is the
	// input-derived live label; `startedAt` stamps the call for its elapsed duration
	// (docs/adr/0026).
	const tools = new Map<string, { name: string; label?: string; startedAt: number }>();
	// The in-progress segment's accumulated text (for segment finalization and
	// transcript persistence only — live-preview accumulation, including
	// reasoning, is each adapter's own concern now), and a finished segment held
	// by the one-segment lookahead until we know whether it is the final
	// (notifying) one.
	let currentDraft = '';
	let pending: string | null = null;
	// Whether a final (notifying) segment has been delivered, so we know if the turn
	// still owes the user a notifying event at the end.
	let notified = false;

	// Flush the held segment, if any: `final` notifies; otherwise it is silent.
	const flushPending = async (final: boolean): Promise<void> => {
		if (pending === null) return;
		const segment = pending;
		pending = null;
		parts.push({ kind: 'text', text: segment });
		await emit({ type: 'segment', markdown: segment, final });
		if (final) notified = true;
	};

	const sink: AgenticSink = {
		beginSegment: async () => {
			// A new segment ⇒ any held segment was not final: flush it silently.
			await flushPending(false);
			currentDraft = '';
			emit({ type: 'segment-start' });
		},
		textDelta: (delta) => {
			currentDraft += delta;
			emit({ type: 'text-delta', delta });
		},
		reasoningDelta: (delta) => {
			emit({ type: 'reasoning-delta', delta });
		},
		endSegment: async () => {
			// Defensive: an unexpected back-to-back end flushes the earlier hold first.
			await flushPending(false);
			const trimmed = currentDraft.trim();
			currentDraft = '';
			pending = trimmed.length ? trimmed : null;
		},
		toolCall: async ({ toolCallId, toolName, input }) => {
			// A tool follows ⇒ any held segment was not final: flush it silently first,
			// so the tool event lands after the segment that preceded it.
			await flushPending(false);
			// The input-label hook reads untrusted tool args, so fail it soft like the
			// summary hook (docs/adr/0026): a throwing hook degrades to a label-less line.
			let label = '';
			try {
				label = labels[toolName]?.(input) ?? '';
			} catch (error) {
				console.error({ message: 'Tool label hook failed', toolName, error });
			}
			emit({ type: 'tool-start', toolCallId, name: toolName, label: label || undefined });
			tools.set(toolCallId, { name: toolName, label: label || undefined, startedAt: Date.now() });
		},
		toolResult: async ({ toolCallId, toolName, output }) => {
			const entry = tools.get(toolCallId);
			if (!entry) return;
			// A summarize hook is author-supplied (`builtinToolSummaries`) and reads the
			// tool's output directly, so fail it soft: a throwing hook degrades to a
			// status-only message rather than aborting an otherwise-successful turn.
			let summary = '';
			try {
				summary = summaries[toolName]?.(output) ?? '';
			} catch (error) {
				console.error({ message: 'Tool summary hook failed', toolName, error });
			}
			const durationMs = Date.now() - entry.startedAt;
			await emit({ type: 'tool-done', toolCallId, summary, durationMs });
			// Persist label + summary but never the duration (docs/adr/0026): a live-only
			// affordance, so it stays off the TranscriptPart and out of context.
			parts.push({ kind: 'tool', name: entry.name, outcome: { label: entry.label, summary } });
		},
		toolError: async ({ toolCallId, error }) => {
			const entry = tools.get(toolCallId);
			if (!entry) return;
			const shortError = truncate(stringifyToolError(error));
			const durationMs = Date.now() - entry.startedAt;
			await emit({ type: 'tool-fail', toolCallId, shortError, durationMs });
			parts.push({ kind: 'tool', name: entry.name, outcome: { label: entry.label, error: shortError } });
		},
	};

	// Show "Thinking…" immediately, before the model produces anything.
	emit({ type: 'segment-start' });

	try {
		await runTurn(sink, trace);
		// Stream completed ⇒ the held segment is the final answer: flush it notifying.
		await flushPending(true);
		// No final answer landed (truly empty, or a turn that ended on a tool): the
		// notice is the turn's single notifying event.
		if (!notified) await emit({ type: 'notice', text: NO_REPLY_NOTICE });
		// Persist the flattened transcript when there is anything to remember.
		if (parts.length > 0) await onReply?.(flattenTranscript(parts));
	} catch (error) {
		// Provider errors can carry the complete request, including image bytes.
		console.error({ message: 'Agentic turn failed', errorType: error instanceof Error ? error.name : 'unknown' });
		// Finalize any partial segment so the user keeps what they already saw, then
		// persist the partial transcript with an interruption marker (docs/adr/0021).
		if (pending === null && currentDraft.trim()) pending = currentDraft.trim();
		currentDraft = '';
		await flushPending(true).catch((e) => console.error({ message: 'Failed to flush partial segment', error: e }));
		if (!notified && !suppressErrorNotice) {
			await Promise.resolve(emit({ type: 'notice', text: NO_REPLY_NOTICE })).catch((e: unknown) =>
				console.error({ message: 'Failed to send notice', error: e }),
			);
		}
		if (parts.length > 0) await onReply?.(flattenTranscript(parts, { interrupted: true }));
		await onError?.(error);
	} finally {
		// `process` is only set once the turn reaches the model call; skip the upload
		// if it failed earlier (nothing useful to report yet).
		if (trace?.process) {
			await Promise.resolve(emit({ type: 'document', trace })).catch((error) =>
				console.error({ message: 'Failed to upload debug trace', error }),
			);
		}
	}
}
