import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});

it('restores separate drafts on conversation switches and forgets a cleared draft', async () => {
	mockFetch();
	render(<Workspace connection={connection} disconnect={() => {}} />);
	const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
	await screen.findByLabelText('Message');
	fireEvent.change(box(), { target: { value: 'First draft' } });
	fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }));
	await waitFor(() => expect(window.location.hash).toBe('#/c/two'));
	expect(box().value).toBe('');
	fireEvent.change(box(), { target: { value: 'Second draft' } });
	fireEvent.click(screen.getByRole('button', { name: 'First conversation' }));
	await waitFor(() => expect(box().value).toBe('First draft'));
	fireEvent.change(box(), { target: { value: '' } });
	fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }));
	await waitFor(() => expect(box().value).toBe('Second draft'));
	fireEvent.click(screen.getByRole('button', { name: 'First conversation' }));
	await waitFor(() => expect(box().value).toBe(''));
});

it('forgets the draft of a conversation deleted while another is open', async () => {
	mockFetch();
	render(<Workspace connection={connection} disconnect={() => {}} />);
	const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
	await screen.findByLabelText('Message');
	fireEvent.change(box(), { target: { value: 'Draft in a deleted conversation' } });
	fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }));
	await waitFor(() => expect(window.location.hash).toBe('#/c/two'));
	fireEvent.keyDown(screen.getByRole('button', { name: 'More for First conversation' }), { key: 'Enter' });
	fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }));
	fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	// Going back to the deleted conversation's address shows an empty composer.
	window.history.replaceState(null, '', '/#/c/one');
	window.dispatchEvent(new PopStateEvent('popstate'));
	await waitFor(() => expect(window.location.hash).toBe('#/c/one'));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(box().value).toBe('');
});

it.each(['/api/conversations', '/api/runtime', '/api/conversations/one'])('retries failed initialization at %s', async (failedPath) => {
	let failing = true;
	mockFetch(path => failing && path === failedPath);
	render(<Workspace connection={connection} disconnect={() => {}} />);
	await screen.findByRole('alert');
	failing = false;
	fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
	await screen.findByLabelText('Message');
	expect(screen.queryByRole('alert')).toBeNull();
	expect(screen.queryByText('Opening workspace…')).toBeNull();
});

it('retries opening the requested conversation while preserving the previous draft', async () => {
	let failing = true;
	mockFetch(path => failing && path === '/api/conversations/two');
	render(<Workspace connection={connection} disconnect={() => {}} />);
	fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'Keep this' } });
	fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }));
	await screen.findByRole('alert');
	failing = false;
	fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
	await waitFor(() => expect(window.location.hash).toBe('#/c/two'));
	expect(screen.queryByRole('alert')).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'First conversation' }));
	await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Keep this'));
});

it('shows every approval parameter before the decision buttons', async () => {
	const input = { command: 'echo start\necho full command ending', directory: '/workspace/project', timeout: 60 };
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (url.endsWith('/events')) return new Response(null, { status: 404 });
		if (url.endsWith('/conversations')) return Response.json(list);
		if (url.endsWith('/runtime')) return Response.json({ background: false });
		if (url.endsWith('/config')) return Response.json({});
		return Response.json({ ...snapshot, messages: [{
			id: 'approval', role: 'assistant', parts: [{
				type: 'dynamic-tool', toolName: 'sandbox', toolCallId: 'call', state: 'approval-requested',
				input, approval: { id: 'approval-id' },
			}],
		}] });
	}));
	render(<Workspace connection={connection} disconnect={() => {}} />);
	const approve = await screen.findByRole('button', { name: 'Allow once' });
	const details = approve.closest('details')!;
	expect(details.open).toBe(true);
	const pre = details.querySelector('pre')!;
	expect(JSON.parse(pre.textContent!)).toEqual(input);
	expect(pre.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('keeps the model trigger open while another client is running a turn, for the next reply', async () => {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (url.endsWith('/events')) return new Response(null, { status: 404 });
		if (url.endsWith('/conversations')) return Response.json(list);
		if (url.endsWith('/runtime')) return Response.json({ background: false });
		if (url.endsWith('/config')) return Response.json({});
		if (url.endsWith('/stream')) return new Promise<Response>(() => {});
		return Response.json({ ...snapshot, active: true });
	}));
	render(<Workspace connection={connection} disconnect={() => {}} />);
	const button = await screen.findByRole('button', { name: 'Demo mode · no model calls' }) as HTMLButtonElement;
	expect(button.disabled).toBe(false);
	expect(button.title).toContain('applies from the next reply');
});

it('shows the default the service kept when making a model the default fails', async () => {
	const fetch = vi.fn(async (url: string) => {
		const path = new URL(url).pathname;
		if (path === '/api/events') return new Response(null, { status: 404 });
		if (path === '/api/conversations') return Response.json(list);
		if (path === '/api/runtime') return Response.json({ background: false });
		if (path === '/api/config') return Response.json({ defaultModel: 'openai/gpt-5' });
		if (path === '/api/models') return Response.json([{ provider: 'openai', name: 'OpenAI', models: [{ id: 'o3', name: 'o3', reasoning: true, efforts: ['low', 'high'] }, { id: 'gpt-5', name: 'GPT-5' }] }]);
		if (path === '/api/commands/run') return Response.json({ error: 'could not write providers.json' }, { status: 500 });
		return Response.json({ ...snapshot, model: 'openai/o3:high' });
	});
	vi.stubGlobal('fetch', fetch);
	render(<Workspace connection={connection} disconnect={() => {}} />);
	fireEvent.click(await screen.findByRole('button', { name: 'openai/o3:high' }));
	fireEvent.click(await screen.findByRole('button', { name: 'Make o3 high the default' }));
	await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('/config')).length).toBeGreaterThan(1));
	expect(screen.getByRole('button', { name: 'Make o3 high the default' })).toBeDefined();
	expect(screen.queryByText(/^Default:/)).toBeNull();
});

it('refreshes conversations before opening a memory from a newly created task', async () => {
	window.history.replaceState(null, '', '/#/manage/memories');
	let requests = 0, added = false;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = new URL(url).pathname;
		if (path === '/api/events') return new Response(null, { status: 404 });
		if (path === '/api/conversations') { requests++; return Response.json(added ? [...list, { id: 'task', title: 'New coding task' }] : list); }
		if (path === '/api/commands') return Response.json([{ name: 'memories' }]);
		if (path === '/api/memories') return Response.json([{ id: 'fact', text: 'Task memory', conversationId: 'task', owner: false }]);
		if (path === '/api/runtime') return Response.json({ background: false });
		if (path === '/api/config') return Response.json({});
		return Response.json(snapshot);
	}));
	render(<Workspace connection={connection} disconnect={() => {}} />);
	const open = await screen.findByRole('button', { name: 'Open conversation' });
	const before = requests;
	added = true;
	fireEvent.click(open);
	await waitFor(() => expect(window.location.hash).toBe('#/c/task'));
	expect(screen.getByRole('button', { name: 'New coding task' })).toBeTruthy();
	expect(requests).toBeGreaterThan(before);
});
