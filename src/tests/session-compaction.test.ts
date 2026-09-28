import { describe, it, expect, vi } from 'vitest';
import { createCompactFunction, type Session, type SessionMessage } from 'agents/sessions';
import { compactSessionText } from '../features/ai/session-compaction';

function fakeSession(messages: SessionMessage[], previous = false) {
	const addCompaction = vi.fn();
	const history = vi.fn(async function* () { yield* messages; });
	return {
		session: {
			history,
			getHistoryRowStats: async () => messages.map((m) => ({ id: m.id, tokenEstimate: 6000 })),
			getCompactions: async () => previous ? [{ id: 'prior', fromMessageId: 'original-start' }] : [],
			addCompaction,
		} as unknown as Session,
		addCompaction, history,
	};
}

describe('text-only session compaction', () => {
	it('keeps image bytes in history but excludes them from the streamed summary and preserves its original anchor', async () => {
		const messages: SessionMessage[] = Array.from({ length: 12 }, (_, i) => ({
			id: String(i), role: i % 2 ? 'assistant' : 'user', parts: [
				{ type: 'text', text: `Caption ${i}: ${'text '.repeat(4800)}` },
				{ type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,cHJpdmF0ZQ==' },
			],
		}));
		messages.splice(3, 0, { id: 'compaction_prior', role: 'user', parts: [{ type: 'text', text: 'Prior summary' }] });
		const { session, addCompaction } = fakeSession(messages, true);
		const summarize = vi.fn(async (_prompt: string) => 'Updated summary');
		await compactSessionText(session, 24000, createCompactFunction({ summarize }));
		expect(summarize).toHaveBeenCalledTimes(1);
		expect(summarize.mock.calls[0]?.[0]).toContain('Prior summary');
		expect(summarize.mock.calls[0]?.[0]).toContain('Caption');
		expect(summarize.mock.calls[0]?.[0]).not.toContain('base64');
		expect(addCompaction).toHaveBeenCalledWith('Updated summary', 'original-start', expect.any(String));
		expect(messages[0].parts[1].url).toContain('base64');
	});

	it('skips hydration below the token threshold', async () => {
		const { session, history, addCompaction } = fakeSession([{ id: '1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }]);
		await compactSessionText(session, 24000, createCompactFunction({ summarize: vi.fn() }));
		expect(history).not.toHaveBeenCalled();
		expect(addCompaction).not.toHaveBeenCalled();
	});

	it('leaves history unchanged if summarization fails', async () => {
		const { session, addCompaction } = fakeSession([{ id: '1', role: 'user', parts: [{ type: 'text', text: 'text' }] }]);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await compactSessionText(session, 0, async () => { throw new Error('private body'); });
			expect(addCompaction).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith({ message: 'Session text compaction failed' });
		} finally { warn.mockRestore(); }
	});
});
