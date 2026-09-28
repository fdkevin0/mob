import { describe, it, expect } from 'vitest';
import {
	DEBUG_TRACE_BYTE_CAP,
	serializeDebugTrace,
	type DebugTrace,
} from '../features/agent/debug-trace';

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

function baseTrace(toolCalls: DebugTrace['toolCalls'] = []): DebugTrace {
	return {
		process: {
			model: 'glm-5',
			promptVersion: 'chat-test.1',
			system: 'You are a concise Telegram chatbot.',
			messages: [{ role: 'user', content: 'hi' }],
			tools: ['search', 'fetch'],
			maxSteps: 5,
			maxOutputTokens: 2048,
		},
		toolCalls,
		usage: { inputTokens: 10, outputTokens: 20 },
		finishReason: 'stop',
	};
}

/**
 * Pins the pure Debug-trace serialization seam (docs/adr/0011): full fidelity
 * under the cap, and defensive truncation of the largest tool-result strings
 * over it. No Durable Object, no Telegram, no AI SDK.
 */
describe('serializeDebugTrace', () => {
	it('preserves a small trace verbatim under the cap (no truncation flag)', () => {
		const trace = baseTrace([
			{ name: 'search', arguments: { q: 'weather' }, result: { temp: 21 } },
		]);
		const json = serializeDebugTrace(trace);
		const parsed = JSON.parse(json) as DebugTrace;

		expect(parsed.truncated).toBeUndefined();
		expect(parsed.toolCalls[0].name).toBe('search');
		expect(JSON.stringify(parsed.toolCalls[0].result) === JSON.stringify({ temp: 21 })).toBe(true);
		expect(parsed.finishReason).toBe('stop');
	});

	it('truncates an over-cap trace, marking it and suffixed with the marker', () => {
		const cap = 2000;
		const huge = 'x'.repeat(50_000);
		const trace = baseTrace([
			{ name: 'fetch', arguments: { url: 'http://big' }, result: huge },
		]);

		const json = serializeDebugTrace(trace, cap);
		expect(byteLength(json)).toBeLessThanOrEqual(cap);

		const parsed = JSON.parse(json) as DebugTrace;
		expect(parsed.truncated).toBe(true);
		const result = parsed.toolCalls[0].result as string;
		expect(typeof result).toBe('string');
		expect(result.endsWith('…[truncated]')).toBe(true);
		expect(result.length < huge.length).toBe(true);
	});

	it('preserves process params through truncation', () => {
		const trace = baseTrace([
			{ name: 'fetch', arguments: { url: 'http://big' }, result: 'y'.repeat(40_000) },
		]);
		const parsed = JSON.parse(serializeDebugTrace(trace, 1500)) as DebugTrace;

		expect(parsed.process).toBeDefined();
		expect(parsed.process!.model).toBe('glm-5');
		expect(parsed.process!.tools.join(',')).toBe('search,fetch');
		expect(parsed.process!.maxSteps).toBe(5);
	});
});

describe('DEBUG_TRACE_BYTE_CAP', () => {
	// The default cap is a sane order of magnitude (well under Telegram's 50 MB).
	it('is a sane size', () => {
		expect(DEBUG_TRACE_BYTE_CAP > 0 && DEBUG_TRACE_BYTE_CAP <= 50_000_000).toBe(true);
	});
});
