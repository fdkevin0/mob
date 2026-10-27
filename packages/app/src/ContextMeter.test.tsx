import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextMeter, liveContext, useContextUsage } from './ContextMeter';
import type { ChatMessage } from './api';
import type { ContextSnapshot } from './contracts';

const connection = { url: 'http://localhost', token: 'local-token' };
const snapshot = (used: number, extra: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
	model: 'anthropic/claude',
	window: 200000,
	reserve: 32000,
	limit: 168000,
	used,
	measured: true,
	parts: { system: 3000, tools: 8800, summary: 2600, messages: used - 3000 - 8800 - 2600 - 31500, outputs: 31500 },
	tools: 12,
	...extra,
});
const reply = (context?: ContextSnapshot): ChatMessage => ({
	id: 'reply',
	role: 'assistant',
	parts: [{ type: 'text', text: 'hi' }, ...(context ? [{ type: 'data-context' as const, id: 'context', data: context }] : [])],
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it('shows the share of what a turn can send, and turns amber then red as it fills', () => {
	const { rerender } = render(<ContextMeter context={snapshot(45360)} busy={false} compact={() => true} />);
	const meter = screen.getByRole('button', { name: /27% of context used/ });
	expect(meter.className).not.toMatch(/warn|full/);
	rerender(<ContextMeter context={snapshot(141600)} busy={false} compact={() => true} />);
	expect(screen.getByRole('button', { name: /84% of context used/ }).className).toContain('warn');
	rerender(<ContextMeter context={snapshot(161000)} busy={false} compact={() => true} />);
	expect(screen.getByRole('button', { name: /96% of context used/ }).className).toContain('full');
});

it('opens what the prompt holds, compacts it, and leads to token usage', () => {
	const compact = vi.fn(() => true);
	const openUsage = vi.fn();
	const usage = {
		totalTokens: 1240000,
		inputTokens: 1,
		outputTokens: 1,
		reasoningTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0.84,
		durationMs: 0,
		requests: 3,
		turns: 2,
		models: [],
	};
	render(
		<ContextMeter context={snapshot(104200, { summarized: 14 })} usage={usage} busy={false} compact={compact} openUsage={openUsage} />,
	);
	fireEvent.click(screen.getByRole('button', { name: /62% of context used/ }));
	const details = screen.getByRole('dialog', { name: 'Context' });
	expect(details.textContent).toContain('104k of 168k tokens a turn can send');
	// Instructions and tool definitions are one part.
	expect(details.textContent).toContain('Instructions & tools · 12 tools12k');
	expect(details.textContent).toContain('Free64k');
	expect(details.textContent).toContain('Kept for the reply · window 200k32k');
	expect(details.textContent).toContain('The first 14 messages are read as a summary');
	expect(details.textContent).toContain('Measured at the last reply');
	expect(details.textContent).toContain('This conversation: 1.24M tokens · $0.84');
	fireEvent.click(screen.getByRole('button', { name: /Compact now/ }));
	expect(compact).toHaveBeenCalled();
	expect(screen.queryByRole('dialog')).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: /62% of context used/ }));
	fireEvent.click(screen.getByRole('button', { name: /Token usage/ }));
	expect(openUsage).toHaveBeenCalled();
});

it('warns before the next turn summarizes, and keeps Compact now for when the turn ends', () => {
	render(<ContextMeter context={snapshot(141600)} busy={true} compact={() => true} />);
	fireEvent.click(screen.getByRole('button', { name: /84% of context used/ }));
	expect(screen.getByRole('dialog').textContent).toContain('Nearly full. The next turn summarizes older messages');
	expect((screen.getByRole('button', { name: /Compact now/ }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows only tokens for a model whose window is unknown, and an agent’s own numbers without compacting', () => {
	const { rerender } = render(
		<ContextMeter
			context={{ model: 'local/qwen', window: 0, reserve: 0, limit: 0, used: 46000, measured: false }}
			busy={false}
			compact={() => true}
		/>,
	);
	expect(screen.getByRole('button', { name: /46k tokens of context; this model's window is unknown/ }).textContent).toBe('46k tokens');
	rerender(
		<ContextMeter
			context={{ model: 'opus', window: 200000, reserve: 0, limit: 200000, used: 82000, measured: true, agent: true }}
			busy={false}
			compact={() => true}
		/>,
	);
	fireEvent.click(screen.getByRole('button', { name: /41% of context used/ }));
	const details = screen.getByRole('dialog');
	expect(details.textContent).toContain("82k of 200k tokens in opus's session");
	expect(details.textContent).toContain('Reported by the coding agent');
	expect(screen.queryByRole('button', { name: /Compact now/ })).toBeNull();
});

it('follows the running reply, then keeps its last report until Mob answers', async () => {
	let answer: (value: Response) => void = () => {};
	const urls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			urls.push(url);
			return new Promise<Response>((resolve) => {
				answer = resolve;
			});
		}),
	);
	const live = snapshot(60000);
	const { result, rerender } = renderHook(({ messages, busy }) => useContextUsage(connection, 'one', messages, 'anthropic/claude', busy), {
		initialProps: { messages: [reply(live)], busy: true },
	});
	expect(liveContext([reply(live)])).toEqual(live);
	expect(result.current.context).toEqual(live);
	expect(urls).toEqual([]);
	// The turn ended and history was reloaded without the part: the last report stays.
	rerender({ messages: [reply()], busy: false });
	expect(result.current.context).toEqual(live);
	await waitFor(() => expect(urls).toEqual(['http://localhost/api/conversations/one/context']));
	const next = snapshot(61000, { measured: false });
	await act(async () => answer(Response.json({ context: next })));
	await waitFor(() => expect(result.current.context).toEqual(next));
});
