import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { chooseFromRunnerMenu } from './runnerMenu.test-helper';
import { cacheScope, forget, readList, readSnapshot, resume, setKeepsMessages, writeList, writeSnapshot } from './localCache';

const connection = { url: 'http://127.0.0.1:8787', token: 'saved' };
const scope = cacheScope(connection);
const reply = (id: string, text: string, active = false) => ({
	messages: [{ id, role: 'assistant' as const, parts: [{ type: 'text' as const, text }] }],
	active,
	model: 'demo/echo',
});
// seed keeps conversations for the saved Mob, as an earlier visit would have.
async function seed(snapshots: Record<string, ReturnType<typeof reply>>, keepMessages = true) {
	resume(scope);
	localStorage.setItem('mob-token', 'saved');
	window.history.replaceState(null, '', '/');
	await setKeepsMessages(keepMessages);
	await writeList(
		scope,
		Object.keys(snapshots).map((id, i) => ({ id, title: `Title ${id}`, updatedAt: i })),
	);
	for (const [id, snapshot] of Object.entries(snapshots)) await writeSnapshot(scope, id, snapshot);
}
const offline = () =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}),
	);
afterEach(async () => {
	vi.unstubAllGlobals();
	localStorage.clear();
	await setKeepsMessages(false);
	await forget(cacheScope(connection));
});

it('opens with what this browser kept while Mob has not answered yet', async () => {
	resume(scope);
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
	resume(scope);
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
	await chooseFromRunnerMenu('Disconnect');
	await screen.findByLabelText('Local access token');
	const { readList } = await import('./localCache');
	await vi.waitFor(async () => expect(await readList(cacheScope(connection))).toBeUndefined());
});

it('forgets kept messages on disconnect even as the open conversation hands them over', async () => {
	await seed({ one: reply('m1', 'kept reply') });
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise<Response>(() => {})),
	);
	render(<App />);
	await screen.findByText('kept reply');
	await chooseFromRunnerMenu('Disconnect');
	await screen.findByLabelText('Local access token');
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(await readList(scope)).toBeUndefined();
	expect(await readSnapshot(scope, 'one')).toBeUndefined();
});

it('forgets what was kept when the saved token is rejected at once', async () => {
	await seed({ one: reply('m1', 'kept reply') });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('unauthorized', { status: 401 })),
	);
	render(<App />);
	await screen.findByLabelText('Local access token');
	await waitFor(async () => expect(await readList(scope)).toBeUndefined());
	expect(await readSnapshot(scope, 'one')).toBeUndefined();
});

it('opens any kept conversation while Mob cannot be reached', async () => {
	await seed({ one: reply('m1', 'reply one'), two: reply('m2', 'reply two') });
	offline();
	render(<App />);
	await screen.findByText('reply one');
	screen.getByRole('button', { name: 'Title two' }).click();
	expect(await screen.findByText('reply two')).toBeTruthy();
	expect(window.location.hash).toBe('#/c/two');
});

it('does not restore a kept running turn as running, so an offline workspace stays usable', async () => {
	await seed({ one: reply('m1', 'reply one', true), two: reply('m2', 'reply two') });
	offline();
	render(<App />);
	await screen.findByText('reply one');
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect((screen.getAllByRole('button', { name: 'New conversation' })[0] as HTMLButtonElement).disabled).toBe(false);
	expect((screen.getByRole('button', { name: 'Title two' }) as HTMLButtonElement).disabled).toBe(false);
});

it('does not keep a deleted conversation again as its thread closes', async () => {
	await seed({ one: reply('a', 'reply one'), two: reply('b', 'reply two') });
	let list = [{ id: 'one', title: 'Title one' }, { id: 'two', title: 'Title two' }];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url.endsWith('/runtime')) return Response.json({ background: false });
			if (url.endsWith('/config')) return Response.json({ defaultModel: 'demo/echo' });
			if (url.endsWith('/conversations')) return Response.json(list);
			if (url.endsWith('/one/delete')) {
				list = list.filter((c) => c.id !== 'one');
				return Response.json({ deleted: true });
			}
			return Response.json(url.endsWith('/two') ? reply('b', 'reply two') : reply('a', 'reply one'));
		}),
	);
	render(<App />);
	await screen.findByText('reply one');
	const nav = within(screen.getByRole('navigation', { name: 'Conversations' }));
	fireEvent.keyDown(nav.getByRole('button', { name: 'More for Title one' }), { key: 'Enter' });
	fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));
	fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
	await screen.findByText('reply two');
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(await readSnapshot(scope, 'one')).toBeUndefined();
	expect((await readList(scope))?.map((c) => c.id)).toEqual(['two']);
});
