import { describe, it, expect } from 'vitest';
import { runTurnCore, type TurnEvent } from '../features/agent/turn-events';
import type { AgenticSink } from '../features/ai/agentic-sink';
import type { DebugTrace } from '../features/agent/debug-trace';

/** Stream a whole text segment through the sink (start → deltas → end). */
async function segment(sink: AgenticSink, text: string): Promise<void> {
	await sink.beginSegment();
	await sink.textDelta(text);
	await sink.endSegment();
}

/**
 * `runTurnCore` is the delivery-neutral heart below Telegram rendering. These
 * tests assert the `TurnEvent` sequence directly, one level below the replay.
 */
describe('runTurnCore — event sequence', () => {
	it('emits an initial segment-start, raw text deltas, then a single finalizing segment', async () => {
		const events: TurnEvent[] = [];
		await runTurnCore({
			emit: (event) => {
				events.push(event);
			},
			runTurn: async (sink) => {
				await segment(sink, 'Hello world');
			},
		});
		expect(events[0]).toEqual({ type: 'segment-start' });
		expect(events).toContainEqual({ type: 'text-delta', delta: 'Hello world' });
		const segments = events.filter((e) => e.type === 'segment');
		expect(segments).toEqual([{ type: 'segment', markdown: 'Hello world', final: true }]);
	});

	it('emits raw reasoning deltas separately from text deltas', async () => {
		const events: TurnEvent[] = [];
		await runTurnCore({
			emit: (event) => {
				events.push(event);
			},
			runTurn: async (sink) => {
				await sink.beginSegment();
				await sink.reasoningDelta('thinking');
				await sink.textDelta('answer');
				await sink.endSegment();
			},
		});
		expect(events).toContainEqual({ type: 'reasoning-delta', delta: 'thinking' });
		expect(events).toContainEqual({ type: 'text-delta', delta: 'answer' });
	});

	it('tool call: tool-start then tool-done, correlated by toolCallId', async () => {
		const events: TurnEvent[] = [];
		await runTurnCore({
			emit: (event) => {
				events.push(event);
			},
			summaries: { search: () => 'found 3' },
			runTurn: async (sink) => {
				await sink.toolCall({ toolCallId: 'a', toolName: 'search', input: {} });
				await sink.toolResult({ toolCallId: 'a', toolName: 'search', output: {} });
				await segment(sink, 'done');
			},
		});
		const start = events.find((e) => e.type === 'tool-start');
		const done = events.find((e) => e.type === 'tool-done');
		expect(start).toMatchObject({ type: 'tool-start', toolCallId: 'a', name: 'search' });
		expect(done).toMatchObject({ type: 'tool-done', toolCallId: 'a', summary: 'found 3' });
	});

	it('tool failure emits tool-fail correlated by toolCallId', async () => {
		const events: TurnEvent[] = [];
		await runTurnCore({
			emit: (event) => {
				events.push(event);
			},
			runTurn: async (sink) => {
				await sink.toolCall({ toolCallId: 'a', toolName: 'fetch_url', input: {} });
				await sink.toolError({ toolCallId: 'a', toolName: 'fetch_url', error: new Error('boom') });
				await segment(sink, 'could not fetch');
			},
		});
		const fail = events.find((e) => e.type === 'tool-fail');
		expect(fail).toMatchObject({ type: 'tool-fail', toolCallId: 'a', shortError: 'boom' });
	});

	it('a truly empty turn emits only the notice, no segment', async () => {
		const events: TurnEvent[] = [];
		let persistedCalled = false;
		await runTurnCore({
			emit: (event) => {
				events.push(event);
			},
			onReply: () => {
				persistedCalled = true;
			},
			runTurn: async () => {},
		});
		expect(events.some((e) => e.type === 'notice')).toBe(true);
		expect(events.some((e) => e.type === 'segment')).toBe(false);
		expect(persistedCalled).toBe(false);
	});

	it('an interrupted turn emits a final segment for the partial answer and calls onError', async () => {
		const events: TurnEvent[] = [];
		let error: unknown;
		await runTurnCore({
			emit: (event) => {
				events.push(event);
			},
			onError: (e) => {
				error = e;
			},
			runTurn: async (sink) => {
				await sink.beginSegment();
				await sink.textDelta('partial answer');
				throw new Error('stream died');
			},
		});
		const segments = events.filter((e) => e.type === 'segment');
		expect(segments).toEqual([{ type: 'segment', markdown: 'partial answer', final: true }]);
		expect(error).toBeInstanceOf(Error);
	});

	it('document is emitted last, only when trace.process was reached', async () => {
		const events: TurnEvent[] = [];
		const trace: DebugTrace = { toolCalls: [] };
		await runTurnCore({
			emit: (event) => {
				events.push(event);
			},
			trace,
			runTurn: async (sink, t) => {
				if (t) t.process = { model: 'm', promptVersion: 'test.1', system: 's', messages: [], tools: [], maxSteps: 1, maxOutputTokens: 1 };
				await segment(sink, 'hi');
			},
		});
		expect(events[events.length - 1]).toMatchObject({ type: 'document' });
	});

	it('emit rejecting for an awaited event surfaces through onError, not as an unhandled rejection', async () => {
		let error: unknown;
		await runTurnCore({
			emit: (event) => {
				if (event.type === 'segment') throw new Error('sink unavailable');
			},
			onError: (e) => {
				error = e;
			},
			runTurn: async (sink) => {
				await segment(sink, 'hello');
			},
		});
		expect(error).toBeInstanceOf(Error);
	});
});
