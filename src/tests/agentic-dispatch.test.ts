import { describe, it, expect } from 'vitest';
import { dispatchChunk, type AgenticSink } from '../features/ai/agentic-sink';
import type { TextStreamPart, ToolSet } from 'ai';

/** A recording sink: captures the method calls `dispatchChunk` makes, in order. */
type SinkCall =
	| { kind: 'beginSegment' }
	| { kind: 'textDelta'; delta: string }
	| { kind: 'endSegment' }
	| { kind: 'reasoningDelta'; delta: string }
	| { kind: 'toolCall'; toolCallId: string; toolName: string; input: unknown }
	| { kind: 'toolResult'; toolCallId: string; toolName: string; output: unknown }
	| { kind: 'toolError'; toolCallId: string; toolName: string; error: unknown };

function recordingSink(): { sink: AgenticSink; calls: SinkCall[] } {
	const calls: SinkCall[] = [];
	const sink: AgenticSink = {
		beginSegment: () => {
			calls.push({ kind: 'beginSegment' });
		},
		textDelta: (delta) => {
			calls.push({ kind: 'textDelta', delta });
		},
		endSegment: () => {
			calls.push({ kind: 'endSegment' });
		},
		reasoningDelta: (delta) => {
			calls.push({ kind: 'reasoningDelta', delta });
		},
		toolCall: (call) => {
			calls.push({ kind: 'toolCall', ...call });
		},
		toolResult: (result) => {
			calls.push({ kind: 'toolResult', ...result });
		},
		toolError: (error) => {
			calls.push({ kind: 'toolError', ...error });
		},
	};
	return { sink, calls };
}

/** A `fullStream` chunk fixture — cast since the tests only set the fields read. */
function chunk(part: { type: string; [key: string]: unknown }): TextStreamPart<ToolSet> {
	return part as unknown as TextStreamPart<ToolSet>;
}

/**
 * Table-tests the pure `dispatchChunk` (docs/adr/0021): each `fullStream` chunk maps
 * to the right sink call, content chunks carry their payload, and non-content chunks
 * are ignored. No model, Durable Object, or Telegram.
 */
describe('dispatchChunk', () => {
	it('maps a text segment (start/delta/end) to begin/textDelta/end', () => {
		const { sink, calls } = recordingSink();
		dispatchChunk(chunk({ type: 'text-start', id: '1' }), sink);
		dispatchChunk(chunk({ type: 'text-delta', id: '1', text: 'hi' }), sink);
		dispatchChunk(chunk({ type: 'text-end', id: '1' }), sink);
		expect(calls).toEqual([
			{ kind: 'beginSegment' },
			{ kind: 'textDelta', delta: 'hi' },
			{ kind: 'endSegment' },
		]);
	});

	it('maps reasoning-delta to reasoningDelta carrying the text', () => {
		const { sink, calls } = recordingSink();
		dispatchChunk(chunk({ type: 'reasoning-delta', id: '1', text: 'pondering' }), sink);
		expect(calls.length).toBe(1);
		expect(calls[0].kind).toBe('reasoningDelta');
		expect((calls[0] as Extract<SinkCall, { kind: 'reasoningDelta' }>).delta).toBe('pondering');
	});

	it('maps tool-call to toolCall with id/name', () => {
		const { sink, calls } = recordingSink();
		dispatchChunk(chunk({ type: 'tool-call', toolCallId: 'a', toolName: 'search', input: { q: 'x' } }), sink);
		expect(calls.length).toBe(1);
		expect(calls[0].kind).toBe('toolCall');
		expect((calls[0] as Extract<SinkCall, { kind: 'toolCall' }>).toolCallId).toBe('a');
		expect((calls[0] as Extract<SinkCall, { kind: 'toolCall' }>).toolName).toBe('search');
	});

	it('maps tool-result to toolResult', () => {
		const { sink, calls } = recordingSink();
		dispatchChunk(chunk({ type: 'tool-result', toolCallId: 'a', toolName: 'search', output: { ok: true } }), sink);
		expect(calls.length).toBe(1);
		expect(calls[0].kind).toBe('toolResult');
		expect((calls[0] as Extract<SinkCall, { kind: 'toolResult' }>).toolCallId).toBe('a');
	});

	it('maps tool-error to toolError carrying the error', () => {
		const { sink, calls } = recordingSink();
		dispatchChunk(chunk({ type: 'tool-error', toolCallId: 'a', toolName: 'search', error: 'boom' }), sink);
		expect(calls.length).toBe(1);
		expect(calls[0].kind).toBe('toolError');
		expect((calls[0] as Extract<SinkCall, { kind: 'toolError' }>).error).toBe('boom');
	});

	it('ignores non-content chunks', () => {
		const { sink, calls } = recordingSink();
		for (const type of ['start', 'finish', 'start-step', 'finish-step', 'reasoning-start', 'reasoning-end', 'tool-input-start', 'raw']) {
			dispatchChunk(chunk({ type }), sink);
		}
		expect(calls.length).toBe(0);
	});
});