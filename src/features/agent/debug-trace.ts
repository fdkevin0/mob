/**
 * The **Debug trace** (see docs/adr/0011): the full-fidelity diagnostic artifact
 * emitted per agentic chat turn while **Debug mode** is on, serialized to a JSON
 * document. This module is the pure, offline-testable seam — it owns the trace
 * shape and the defensive size cap; the runtime capture lives in `runAgenticTurn`
 * and the delivery in the `ConversationAgent`.
 */

/** One tool call within a turn: name, the input it was called with, and its result. */
export interface DebugToolCall {
	name: string;
	arguments: unknown;
	/** The tool's output. Absent if the call errored. */
	result?: unknown;
	/** Set instead of `result` when the call failed. */
	error?: string;
}

/** The `streamText` configuration for the turn — the "chat process parameters". */
export interface DebugProcessParams {
	model: string;
	/** Version of the system-prompt contract used for this turn. */
	promptVersion: string;
	system: string;
	/** The windowed messages actually sent to the model (no system message). */
	messages: unknown;
	/** Names of the tools available to the turn. Never their auth/credentials. */
	tools: string[];
	maxSteps: number;
	maxOutputTokens: number;
}

/** A single turn's complete trace. */
export interface DebugTrace {
	/** Set once the turn reaches the model call; absent if it failed earlier. */
	process?: DebugProcessParams;
	/** Auto-recalled memory facts injected into the turn (docs/adr/0038). */
	recalledMemories?: Array<{ text: string; score: number }>;
	toolCalls: DebugToolCall[];
	/** Token usage for the turn, when available. */
	usage?: unknown;
	finishReason?: string;
	/** Set by `serializeDebugTrace` when the defensive cap forced truncation. */
	truncated?: boolean;
}

/** Defensive ceiling on the serialized trace (~1 MB), well under Telegram's 50 MB. */
export const DEBUG_TRACE_BYTE_CAP = 1_000_000;

const TRUNCATION_MARKER = '…[truncated]';

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

function resultByteLength(result: unknown): number {
	if (result === undefined) return 0;
	return byteLength(typeof result === 'string' ? result : JSON.stringify(result));
}

/**
 * Serialize a trace to pretty JSON, bounded by `cap` bytes. Full fidelity under
 * the cap; over it, the **largest tool-result strings** are progressively
 * truncated (with a marker) and `truncated: true` is set — a pathological MCP
 * tool result can't blow the upload. Best-effort if the overflow isn't in tool
 * results (the windowed messages are bounded by the history cap, so this is the
 * realistic overflow source).
 */
export function serializeDebugTrace(trace: DebugTrace, cap: number = DEBUG_TRACE_BYTE_CAP): string {
	const full = JSON.stringify(trace, null, 2);
	if (byteLength(full) <= cap) return full;

	// Work on a deep clone of the serializable content so the caller's trace is
	// left untouched.
	const clone: DebugTrace = JSON.parse(full);
	clone.truncated = true;

	// Each pass halves the largest tool result; a few dozen passes per result is
	// far more than enough to converge, and the loop also exits as soon as it fits
	// or nothing is left to shrink.
	const maxPasses = clone.toolCalls.length * 64 + 64;
	for (let guard = 0; guard < maxPasses; guard++) {
		const json = JSON.stringify(clone, null, 2);
		if (byteLength(json) <= cap) return json;

		// Shrink the current largest tool result by half.
		let target = -1;
		let max = byteLength(TRUNCATION_MARKER);
		clone.toolCalls.forEach((call, i) => {
			const len = resultByteLength(call.result);
			if (len > max) {
				max = len;
				target = i;
			}
		});
		if (target < 0) break; // nothing left to shrink — return best effort below

		const call = clone.toolCalls[target];
		const asString = typeof call.result === 'string' ? call.result : JSON.stringify(call.result);
		const keep = Math.max(0, Math.floor(asString.length / 2) - TRUNCATION_MARKER.length);
		call.result = asString.slice(0, keep) + TRUNCATION_MARKER;
	}

	return JSON.stringify(clone, null, 2);
}
