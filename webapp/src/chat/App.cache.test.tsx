import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { cacheScope, forget, setKeepsMessages, writeList, writeSnapshot } from './localCache';

const connection = { url: 'http://127.0.0.1:8787', token: 'saved' };
afterEach(async () => {
	vi.unstubAllGlobals();
	localStorage.clear();
	await setKeepsMessages(false);
	await forget(cacheScope(connection));
});

it('opens with what this browser kept while Mob has not answered yet', async () => {
	localStorage.setItem('mob-token', 'saved');
	window.history.replaceState(null, '', '/');
	await setKeepsMessages(true);
	await writeList(cacheScope(connection), [{ id: 'one', title: 'Kept title', updatedAt: 1 }]);
	await writeSnapshot(cacheScope(connection), 'one', {
		messages: [{ id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'kept reply' }] }],
		active: false,
		model: 'demo/echo',
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise<Response>(() => {})),
	);
	render(<App />);
	expect(await screen.findByText('kept reply')).toBeTruthy();
	expect(screen.getAllByText('Kept title').length).toBeGreaterThan(0);
	expect(window.location.hash).toBe('#/c/one');
});

it('shows only titles until messages are kept, and forgets them on disconnect', async () => {
	localStorage.setItem('mob-token', 'saved');
	window.history.replaceState(null, '', '/');
	await writeList(cacheScope(connection), [{ id: 'one', title: 'Kept title', updatedAt: 1 }]);
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise<Response>(() => {})),
	);
	render(<App />);
	expect(await screen.findByRole('button', { name: 'Kept title' })).toBeTruthy();
	expect(screen.queryByText('kept reply')).toBeNull();
	screen.getByRole('button', { name: /disconnect/i }).click();
	await screen.findByLabelText('Local access token');
	const { readList } = await import('./localCache');
	await vi.waitFor(async () => expect(await readList(cacheScope(connection))).toBeUndefined());
});
