import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { AssetDetailScreen, AssetListScreen } from './BookmarkScreen';
import { api } from '../api';

vi.mock('../api', () => ({ api: { listBookmarks: vi.fn(), getBookmark: vi.fn(), deleteBookmark: vi.fn(), retryBookmark: vi.fn(), bookmarkFile: vi.fn() } }));
const row = { id: '12345678-1234-1234-1234-123456789012', title: 'Deployment instructions', kind: 'text', note: '', created: 1, status: 'saved' as const, indexStatus: 'ready' as const, snippet: 'Deployment considerations' };
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.listBookmarks).mockResolvedValue({ assets: [row], mode: 'local' });
	vi.mocked(api.getBookmark).mockResolvedValue({ asset: { ...row, text: '<script>private content</script>', urls: [], files: [] } });
});

it('searches on submit, shows fallback scope, and opens a selected bookmark', async () => {
	const select = vi.fn();
	render(<AssetListScreen onSelect={select} />);
	fireEvent.click(await screen.findByRole('button', { name: /Deployment instructions/ }));
	expect(select).toHaveBeenCalledWith(row.id);
	vi.mocked(api.listBookmarks).mockResolvedValue({ assets: [], mode: 'local', warning: 'AI Search is temporarily unavailable. Searching titles and notes only.' });
	fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Cloudflare' } });
	fireEvent.click(screen.getByRole('button', { name: 'Search' }));
	await screen.findByText('No matching bookmarks.');
	expect(api.listBookmarks).toHaveBeenLastCalledWith({ query: 'Cloudflare', kind: '' });
	expect(screen.getByText(/AI Search is temporarily unavailable/)).toBeTruthy();
});

it('renders untrusted content as text and confirms deletion before sending it', async () => {
	const deleted = vi.fn();
	vi.mocked(api.deleteBookmark).mockResolvedValue({ ok: true });
	const { container } = render(<AssetDetailScreen id={row.id} onDeleted={deleted} />);
	await screen.findByText('<script>private content</script>');
	expect(container.querySelector('script')).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Delete bookmark' }));
	expect(api.deleteBookmark).not.toHaveBeenCalled();
	fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
	await waitFor(() => expect(deleted).toHaveBeenCalledTimes(1));
	expect(api.deleteBookmark).toHaveBeenCalledWith(row.id);
});

it('offers retry when original saving failed', async () => {
	vi.mocked(api.getBookmark).mockResolvedValue({ asset: { ...row, status: 'failed', text: '', urls: [], files: [] } });
	vi.mocked(api.retryBookmark).mockResolvedValue({ ok: true });
	render(<AssetDetailScreen id={row.id} onDeleted={() => {}} />);
	fireEvent.click(await screen.findByRole('button', { name: 'Retry processing' }));
	await waitFor(() => expect(api.retryBookmark).toHaveBeenCalledWith(row.id));
});
