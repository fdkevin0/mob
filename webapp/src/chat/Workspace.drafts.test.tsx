import 'fake-indexeddb/auto';
import * as cache from './localCache';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Workspace } from './Workspace';

const connection = { url: 'http://localhost', token: 'test' };
const snapshot = { messages: [], active: false, model: 'demo/echo' };
const list = [{ id: 'one', title: 'First conversation' }, { id: 'two', title: 'Second conversation' }];
function mockFetch(fail?: (path: string) => boolean) {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = new URL(url).pathname;
		if (fail?.(path)) return Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
		if (path === '/api/events') return new Response(null, { status: 404 });
		if (path === '/api/conversations') return Response.json(list);
		if (path === '/api/runtime') return Response.json({ background: false });
		if (path === '/api/config') return Response.json({});
		return Response.json(snapshot);
	}));
}
afterEach(async () => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await cache.forget(cache.cacheScope(connection));
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});

it('saves both the current and switched-away drafts when keeping is enabled', async () => {
	cache.resume(cache.cacheScope(connection));
	await cache.setKeepsMessages(false);
	mockFetch();
	render(<Workspace connection={connection} disconnect={() => {}} />);
	fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'First draft' } });
	fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }));
	await waitFor(() => expect(screen.getByRole('heading', { name: 'Second conversation' })).toBeTruthy());
	fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Second draft' } });
	fireEvent.click(screen.getByRole('button', { name: 'First conversation' }));
	await waitFor(() => expect(screen.getByRole('heading', { name: 'First conversation' })).toBeTruthy());
	expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('First draft');
	fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Latest first draft' } });
	fireEvent.pointerDown(screen.getByRole('button', { name: /settings and runner/ }), { button: 0, ctrlKey: false });
	fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Keep messages on this device' }));
	await waitFor(async () => {
		expect(await cache.readDraft(cache.cacheScope(connection), 'one')).toBe('Latest first draft');
		expect(await cache.readDraft(cache.cacheScope(connection), 'two')).toBe('Second draft');
	});
});

it('restores a saved draft after switching away during its initial read', async () => {
	const scope = cache.cacheScope(connection);
	cache.resume(scope);
	await cache.setKeepsMessages(true);
	await cache.writeDraft(scope, 'one', 'Saved first draft');
	let resolve!: (value: string) => void;
	vi.spyOn(cache, 'readDraft').mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
	mockFetch();
	render(<Workspace connection={connection} disconnect={() => {}} />);
	await screen.findByLabelText('Message');
	fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }));
	await waitFor(() => expect(screen.getByRole('heading', { name: 'Second conversation' })).toBeTruthy());
	resolve('Saved first draft');
	fireEvent.click(screen.getByRole('button', { name: 'First conversation' }));
	await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Saved first draft'));
	expect(await cache.readDraft(scope, 'one')).toBe('Saved first draft');
});
