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

it.each(['/api/conversations', '/api/runtime', '/api/conversations/one'])('retries failed initialization at %s', async (failedPath) => {
	let failing = true;
	mockFetch(path => failing && path === failedPath);
	render(<Workspace connection={connection} disconnect={() => {}} />);
	await screen.findByRole('alert');
	failing = false;
	fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
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
	fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
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

it('disables the model trigger while another client is running a turn', async () => {
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
	expect(button.disabled).toBe(true);
	expect(button.title).toContain('Wait for the current turn');
});
