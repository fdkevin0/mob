import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Usage, fillDays, tokens } from './Usage';
import type { UsageReport } from './contracts';

const connection = { url: 'http://localhost', token: 'local-token' };
const counts = { reasoningTokens: 0, cacheWriteTokens: 0, cost: 0, durationMs: 0, requests: 1 };
const report: UsageReport = {
	since: 1,
	totalTokens: 12000,
	inputTokens: 10000,
	outputTokens: 2000,
	reasoningTokens: 500,
	cacheReadTokens: 8000,
	cacheWriteTokens: 1000,
	cost: 1.5,
	durationMs: 65000,
	requests: 4,
	turns: 3,
	conversations: 2,
	models: [{ model: 'anthropic/claude', ...counts, totalTokens: 12000, inputTokens: 10000, outputTokens: 2000, cacheReadTokens: 8000 }],
	days: [{ date: '2026-10-20', ...counts, totalTokens: 12000, inputTokens: 10000, outputTokens: 2000, cacheReadTokens: 8000 }],
	top: [{ id: 'task-conversation', title: 'codex: fix tests', agent: 'codex', ...counts, totalTokens: 12000, inputTokens: 10000, outputTokens: 2000, cacheReadTokens: 8000, turns: 3 }],
};
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it('shows totals, the cache share and the top conversations for the chosen period', async () => {
	const urls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			urls.push(url);
			return Response.json(report);
		}),
	);
	const open = vi.fn();
	render(<Usage connection={connection} close={() => {}} open={open} />);
	expect((await screen.findAllByText('12k')).length).toBeGreaterThan(0);
	expect(screen.getAllByText('80%').length).toBeGreaterThan(0);
	expect(screen.getByText('$1.50')).toBeTruthy();
	expect(screen.getByText('1m 5s')).toBeTruthy();
	expect(screen.getByText('task · codex')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'codex: fix tests' }));
	expect(open).toHaveBeenCalledWith('task-conversation');
	expect(urls[0]).toContain('/api/usage?days=30');
	fireEvent.mouseDown(screen.getByRole('tab', { name: 'All time' }));
	await waitFor(() => expect(urls.at(-1)).toContain('/api/usage?days=0'));
});

it('says so when nothing was used', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...report, totalTokens: 0, models: [], days: [], top: [] })));
	render(<Usage connection={connection} close={() => {}} open={() => {}} />);
	expect(await screen.findByText(/No tokens were used in this period/)).toBeTruthy();
});

it('gives every day of the period a column', () => {
	const days = fillDays(report.days, 7, new Date(2026, 9, 21));
	expect(days.map((d) => d.date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
	expect(days[5].totalTokens).toBe(12000);
	expect(fillDays([], 0)).toEqual([]);
	expect([tokens(950), tokens(12345), tokens(1240000)]).toEqual(['950', '12k', '1.24M']);
});
