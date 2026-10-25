import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ReplyMeta, modelName, speed } from './ReplyMeta';
import type { ChatMessage } from './api';
import { seconds } from './format';

afterEach(cleanup);

const reply = (metadata: ChatMessage['metadata']): ChatMessage => ({ id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'hi' }], metadata });
const stats = { startedAt: 1_000, finishedAt: 15_200, firstTokenMs: 900, generationMs: 7_400, timedOutput: 385, toolMs: 4_200, requests: 3 };
const usage = { inputTokens: 12_400, outputTokens: 1_800, reasoningTokens: 420, cacheReadTokens: 9_600, cost: 0.031 };

it('names a model without its provider or reasoning level', () => {
	expect(modelName('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
	expect(modelName('openai/o3:high')).toBe('o3');
	expect(modelName('openrouter/deepseek/deepseek-r1:free')).toBe('deepseek/deepseek-r1:free');
	expect(modelName('codex')).toBe('codex');
});

it('measures speed only over the time the model was writing', () => {
	expect(speed(stats)).toBeCloseTo(52.03, 1);
	expect(speed({ startedAt: 1, finishedAt: 9 })).toBeUndefined();
	expect(speed(undefined)).toBeUndefined();
	expect([seconds(420), seconds(12_300), seconds(65_000)]).toEqual(['0.4s', '12s', '1m 05s']);
});

it('says under a reply which model wrote it, its tokens and speed, and opens the details', () => {
	render(<ReplyMeta message={reply({ model: 'anthropic/claude-sonnet-4-5:medium', usage, stats })} live={false} />);
	const button = screen.getByRole('button', { name: 'Reply details: claude-sonnet-4-5 · 14k tokens · 52 tok/s' });
	expect(screen.getByRole('img', { name: 'Claude' })).toBeTruthy();
	fireEvent.click(button);
	const details = screen.getByRole('dialog', { name: 'claude-sonnet-4-5' });
	expect(details.textContent).toContain('anthropic · reasoning medium');
	for (const text of ['Input12k', 'Output1.8k', 'Speed52 tok/s', 'Writing 7.4s', 'Tools 4.2s', 'Other 2.6s', 'First token0.9s', 'Cache read9.6k (77%)', 'Reasoning tokens420', 'Model requests3', 'Total time14s', 'Cost$0.031'])
		expect(details.textContent).toContain(text);
	// The details open beside the conversation, not inside the message, which may be clipped while off screen.
	expect(details.closest('.message, .conversation-content')).toBeNull();
});

it('keeps the wait for the first words out of the time bar, since summaries and tools may run within it', () => {
	// A 10s reply: a summary written for 5s before the first visible words at 8s, then 2s of writing.
	const overlapping = { startedAt: 0, finishedAt: 10_000, firstTokenMs: 8_000, generationMs: 7_000, timedOutput: 140, requests: 2 };
	render(<ReplyMeta message={reply({ model: 'openai/gpt-5', usage: { inputTokens: 900, outputTokens: 140 }, stats: overlapping })} live={false} />);
	fireEvent.click(screen.getByRole('button'));
	const legend = [...screen.getByRole('dialog').querySelectorAll('.reply-time-legend li')].map((li) => li.textContent);
	expect(legend).toEqual(['Writing 7.0s', 'Other 3.0s']);
	expect(screen.getByRole('dialog').textContent).toContain('First token8.0s');
});

it('names the model alone while the reply is written, and an agent reply shows its time', () => {
	const { rerender } = render(<ReplyMeta message={reply({ model: 'openai/gpt-5', stats: { startedAt: 1 } })} live />);
	expect(screen.queryByRole('button')).toBeNull();
	expect(screen.getByText('gpt-5')).toBeTruthy();
	rerender(<ReplyMeta message={reply({ model: 'codex', usage: { inputTokens: 500, outputTokens: 20 }, stats: { startedAt: 0, finishedAt: 30_000, firstTokenMs: 2_000 } })} live={false} />);
	fireEvent.click(screen.getByRole('button', { name: 'Reply details: codex · 520 tokens' }));
	expect(screen.getByRole('dialog').textContent).toContain('Time30s');
	rerender(<ReplyMeta message={reply({ status: 'complete' })} live={false} />);
	expect(screen.queryByText(/tokens/)).toBeNull();
});
