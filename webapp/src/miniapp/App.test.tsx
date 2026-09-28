import { StrictMode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { api } from './api';
import { getWebApp } from './telegram';

vi.mock('./api', async (importOriginal) => ({
	...await importOriginal<typeof import('./api')>(),
	api: { bootstrap: vi.fn(), chatSettingsData: vi.fn() },
}));
vi.mock('./telegram', async (importOriginal) => ({
	...await importOriginal<typeof import('./telegram')>(),
	getWebApp: vi.fn(), setupWebApp: vi.fn(),
}));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.bootstrap).mockResolvedValue({ capabilities: [], language: null });
	vi.mocked(api.chatSettingsData).mockResolvedValue({ reasoningEffort: 'default', compactionThreshold: 100000, memoryTopK: 5 });
});

it('provides browser Back navigation and resets the scroll position on screen changes', async () => {
	render(<App />);
	await screen.findByRole('button', { name: 'Chat settings' });
	expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
	const scroll = vi.spyOn(window, 'scrollTo');
	scroll.mockClear();
	fireEvent.click(screen.getByRole('button', { name: 'Chat settings' }));
	await screen.findByRole('heading', { name: 'Chat settings' });
	expect(scroll).toHaveBeenCalledWith(0, 0);
	fireEvent.click(screen.getByRole('button', { name: 'Back' }));
	await screen.findByRole('button', { name: 'Chat settings' });
	expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
});

it('binds one native Back handler and removes it on root navigation and unmount', async () => {
	const handlers = new Set<() => void>();
	const BackButton = {
		show: vi.fn(), hide: vi.fn(),
		onClick: vi.fn((fn: () => void) => { handlers.add(fn); }),
		offClick: vi.fn((fn: () => void) => { handlers.delete(fn); }),
	};
	vi.mocked(getWebApp).mockReturnValue({
		initData: '', ready: vi.fn(), expand: vi.fn(), isVersionAtLeast: () => true, BackButton,
		setHeaderColor: vi.fn(), setBackgroundColor: vi.fn(), setBottomBarColor: vi.fn(),
		onEvent: vi.fn(), offEvent: vi.fn(),
	});
	const { unmount } = render(<StrictMode><App /></StrictMode>);
	await screen.findByRole('button', { name: 'Chat settings' });
	fireEvent.click(screen.getByRole('button', { name: 'Chat settings' }));
	await screen.findByRole('heading', { name: 'Chat settings' });
	expect(handlers.size).toBe(1);
	expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
	act(() => { [...handlers][0](); });
	await screen.findByRole('button', { name: 'Chat settings' });
	expect(handlers.size).toBe(0);
	fireEvent.click(screen.getByRole('button', { name: 'Chat settings' }));
	await screen.findByRole('heading', { name: 'Chat settings' });
	unmount();
	expect(handlers.size).toBe(0);
	expect(BackButton.hide).toHaveBeenCalled();
});

it('shows a loading placeholder and retries a failed bootstrap', async () => {
	vi.mocked(api.bootstrap).mockRejectedValueOnce(new Error('offline'));
	render(<App />);
	expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
	await screen.findByRole('alert');
	expect(screen.queryByRole('navigation')).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
	await screen.findByRole('button', { name: 'Chat settings' });
	expect(api.bootstrap).toHaveBeenCalledTimes(2);
	expect(screen.queryByRole('alert')).toBeNull();
});
