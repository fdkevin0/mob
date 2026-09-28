/**
 * The **AgenticSink** seam and the pure `fullStream` → sink dispatch (docs/adr/0021).
 *
 * Kept in its own module — free of the `agents` runtime and the Durable Object — so
 * the dispatch is table-testable under vitest (the `agents` package pulls in
 * `cloudflare:` imports the test loader can't resolve). `runAgenticTurn` in
 * `agentic.ts` drives a real model into this sink; tests script it directly.
 */
import type { TextStreamPart, ToolSet } from 'ai';

/** A tool call as it crosses the sink (docs/adr/0021), correlated by `toolCallId`. */
export interface SinkToolCall {
	toolCallId: string;
	toolName: string;
	input: unknown;
}

/** A tool's successful result, correlated to its call by `toolCallId`. */
export interface SinkToolResult {
	toolCallId: string;
	toolName: string;
	output: unknown;
}

/** A tool's failure, correlated to its call by `toolCallId`. */
export interface SinkToolError {
	toolCallId: string;
	toolName: string;
	error: unknown;
}

/**
 * What the caller does with each piece of the streamed turn — a direct mapping of
 * `streamText`'s `fullStream` events (docs/adr/0021, superseding ADR-0010's single
 * draft). A turn is a sequence of **text segments** interleaved with **tool calls**:
 * `beginSegment`/`textDelta`/`endSegment` bracket a streamed segment, and the tool
 * trio reports each call's lifecycle. Methods may be async so the orchestrator can
 * `await` persistent sends in submission order. The Telegram **Transcript**
 * orchestrator (`runTurnCore`) implements this; tests script it directly.
 */
export interface AgenticSink {
	/** A new text segment began (`text-start`). */
	beginSegment(): void | Promise<void>;
	/** A text delta within the current segment (`text-delta`). */
	textDelta(delta: string): void | Promise<void>;
	/** The current text segment ended (`text-end`). */
	endSegment(): void | Promise<void>;
	/**
	 * A reasoning delta (`reasoning-delta`) — the model's live chain-of-thought,
	 * shown only in the ephemeral draft, never persisted. No `begin`/`end` pair,
	 * since nothing distinguishes those edges behaviorally.
	 */
	reasoningDelta(delta: string): void | Promise<void>;
	/** A tool was invoked (`tool-call`). */
	toolCall(call: SinkToolCall): void | Promise<void>;
	/** A tool returned a result (`tool-result`). */
	toolResult(result: SinkToolResult): void | Promise<void>;
	/** A tool threw (`tool-error`). */
	toolError(error: SinkToolError): void | Promise<void>;
}

/**
 * Pure translation of one `fullStream` chunk into a sink call (docs/adr/0021).
 * Kept separate from `runAgenticTurn` so it is table-testable with synthetic chunk
 * fixtures, with no model, Durable Object, or Telegram. Non-content chunks
 * (`start`, `finish`, `reasoning-start`, `reasoning-end`, `tool-input-*`, etc.) are
 * ignored — the Transcript renders only finished text segments and tool calls, and
 * reasoning has no finalized edges (only `reasoning-delta` feeds the live draft).
 * Returns the sink call's promise (if any) so callers can await ordered delivery.
 */
export function dispatchChunk(chunk: TextStreamPart<ToolSet>, sink: AgenticSink): void | Promise<void> {
	switch (chunk.type) {
		case 'text-start':
			return sink.beginSegment();
		case 'text-delta':
			return sink.textDelta(chunk.text);
		case 'text-end':
			return sink.endSegment();
		case 'reasoning-delta':
			return sink.reasoningDelta(chunk.text);
		case 'tool-call':
			return sink.toolCall({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input });
		case 'tool-result':
			return sink.toolResult({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, output: chunk.output });
		case 'tool-error':
			return sink.toolError({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, error: chunk.error });
		default:
			return;
	}
}
