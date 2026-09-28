import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryScreen } from './MemoryScreen';
import { api } from '../api';

vi.mock('../api', () => ({ api: { listMemories: vi.fn(), forgetMemories: vi.fn() } }));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.listMemories).mockResolvedValue({ memories: [
		{ id: '1', text: 'Prefers Chinese replies.', ts: 0, layer: 'knowledge', source: 'explicit', confirmations: 1, lastSeenTs: 0 },
		{ id: '2', text: 'Working on a bot.', ts: 0, layer: 'working', source: 'extracted', confirmations: 2, lastSeenTs: 86400000 },
	] });
});

it('shows facts and their dates under counted layer headings', async () => {
	render(<MemoryScreen />);
	await screen.findByRole('heading', { name: 'Knowledge (1)' });
	expect(screen.getByRole('heading', { name: 'Working memory (1)' })).toBeTruthy();
	expect(screen.getByText('Prefers Chinese replies.')).toBeTruthy();
	expect(screen.getByText('Working on a bot.')).toBeTruthy();
	expect(screen.getAllByText(/1970-01-01/)).toHaveLength(2);
	expect(screen.getByText(/Seen 1970-01-02/)).toBeTruthy();
	expect(screen.getByText(/×2/)).toBeTruthy();
});

it('requires confirmation before wiping both groups and shows the empty state', async () => {
	vi.mocked(api.forgetMemories).mockResolvedValue({ ok: true, count: 2 });
	render(<MemoryScreen />);
	fireEvent.click(await screen.findByRole('button', { name: 'Forget all' }));
	expect(api.forgetMemories).not.toHaveBeenCalled();
	fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Forget all' }));
	await screen.findByText('No memories yet');
	expect(api.forgetMemories).toHaveBeenCalledTimes(1);
	expect(screen.queryByText('Prefers Chinese replies.')).toBeNull();
	expect(screen.queryByText('Working on a bot.')).toBeNull();
});

it('cancels the native confirmation without deleting memories', async () => {
	render(<MemoryScreen />);
	fireEvent.click(await screen.findByRole('button', { name: 'Forget all' }));
	fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
	expect(api.forgetMemories).not.toHaveBeenCalled();
	expect(screen.getByText('Prefers Chinese replies.')).toBeTruthy();
});

it('retains facts while refreshing and allows retry after refresh fails', async () => {
	let rejectRefresh!: (error: Error) => void;
	render(<MemoryScreen />);
	await screen.findByText('Prefers Chinese replies.');
	vi.mocked(api.listMemories).mockReturnValueOnce(new Promise((_, reject) => { rejectRefresh = reject; }));
	const refresh = screen.getByRole('button', { name: 'Refresh memory' }) as HTMLButtonElement;
	fireEvent.click(refresh);
	expect(refresh.disabled).toBe(true);
	expect(screen.getByText('Prefers Chinese replies.')).toBeTruthy();
	expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
	rejectRefresh(new Error('offline'));
	await screen.findByRole('alert');
	vi.mocked(api.listMemories).mockResolvedValueOnce({ memories: [] });
	fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
	await screen.findByText('No memories yet');
	expect(screen.queryByRole('alert')).toBeNull();
});
