import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage, Snapshot } from './api';
import { Thread, askedBy, fences, quiet } from './Thread';

const connection = { url: 'http://localhost', token: 'test' };
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
function show(snapshot: Partial<Snapshot>, browser = false) {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
	const initial = { messages: [], active: false, model: 'demo/echo', ...snapshot } as Snapshot;
	return render(<Thread connection={{ ...connection, browser }} id="one" initial={initial} onChanged={() => {}} onAction={() => {}} />);
}
const said = (role: 'user' | 'assistant', text: string, id: string = role) => ({ id, role, parts: [{ type: 'text' as const, text }] }) as ChatMessage;

it('shows the owner’s message as typed, with code in a monospace face and no tables, and folds a long one', () => {
	const typed = 'Look at `dedupe`:\n\n```ts\nconst seen = new Set();\n```\n\n| size | time |\n|---|---|';
	const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
	const view = show({ messages: [said('user', typed, 'u1'), said('assistant', 'ok', 'a1'), said('user', long, 'u2')] });
	const [first, second] = view.container.querySelectorAll<HTMLElement>('.user-text');
	expect(first.querySelector('code')?.textContent).toBe('dedupe');
	expect(first.querySelector('pre')?.textContent).toBe('const seen = new Set();');
	expect(first.textContent).toContain('| size | time |');
	expect(view.container.querySelector('.user-bubble table')).toBeNull();
	expect(first.dataset.folded).toBeUndefined();
	expect(second.dataset.folded).toBe('true');
	fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
	expect(second.dataset.folded).toBeUndefined();
	expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
	expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(2);
	expect(screen.getAllByRole('button', { name: 'Copy reply' })).toHaveLength(1);
});

it('reads fenced blocks as Markdown does, so a longer fence keeps the examples inside it', () => {
	const nested = 'Example:\n````md\n```ts\nconst a = 1;\n```\n````\nafter';
	expect(fences(nested)).toEqual(['Example:', '```ts\nconst a = 1;\n```', 'after']);
	expect(fences('~~~\n```\n~~~')).toEqual(['', '```', '']);
	expect(fences('```ts\nnever closed')).toEqual(['```ts\nnever closed']);
	expect(fences('Use ```a``` here\n```\nb\n```')).toEqual(['Use ```a``` here', 'b', '']);
	const view = show({ messages: [said('user', nested)] });
	expect(view.container.querySelector('.user-text pre')?.textContent).toBe('```ts\nconst a = 1;\n```');
	expect(view.container.querySelector('.user-text')?.textContent).not.toContain('````');
});

it('says it is working only while nothing else shows Mob at work', () => {
	const tool = (state: string) => ({ id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 'c', state, input: {} }] }) as ChatMessage;
	expect(quiet(said('user', 'hi'))).toBe(false);
	expect(quiet({ id: 'a', role: 'assistant', parts: [] } as ChatMessage)).toBe(false);
	expect(quiet(said('assistant', 'Hel'))).toBe(true);
	expect(quiet(tool('input-available'))).toBe(true);
	expect(quiet(tool('approval-requested'))).toBe(true);
	expect(quiet(tool('output-available'))).toBe(false);
	expect(quiet({ id: 'a', role: 'assistant', parts: [{ type: 'reasoning', text: 'Let me think' }] } as ChatMessage)).toBe(false);
});

it('keeps saying it is working while a reply only reasons, behind the closed Reasoning row', async () => {
	const chunks = ['{"type":"start","messageId":"a"}', '{"type":"start-step"}', '{"type":"reasoning-start","id":"r"}', '{"type":"reasoning-delta","id":"r","delta":"Let me think"}'];
	// The stream stays open: the reply is still reasoning.
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`));
		},
	});
	const view = show({});
	vi.stubGlobal('fetch', vi.fn(async (url: string) =>
		url.endsWith('/chat')
			? new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
			: Response.json({ messages: [], active: false, model: 'demo/echo' }),
	));
	const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
	fireEvent.change(box, { target: { value: 'think' } });
	fireEvent.submit(box.closest('form')!);
	await waitFor(() => expect(view.container.querySelector('details.reasoning')).toBeTruthy());
	expect(view.container.querySelector<HTMLDetailsElement>('details.reasoning')?.open).toBe(false);
	expect(screen.getByRole('status').textContent).toBe('Working…');
});

it('offers ways to start a new conversation, which fill the message box, and none a browser cannot do', () => {
	show({});
	const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
	expect(screen.getByRole('button', { name: 'Fix a bug with Codex' })).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Remember something' }));
	expect(box.value).toBe('Remember that I prefer short answers');
	expect(screen.queryByRole('list', { name: 'Ways to start' })).toBeNull();
	cleanup();
	show({}, true);
	expect(screen.queryByRole('button', { name: 'Fix a bug with Codex' })).toBeNull();
	expect(screen.getAllByRole('listitem')).toHaveLength(3);
});

it('points to an approval scrolled out of view from above the message box', () => {
	let report: (entries: { isIntersecting: boolean }[]) => void = () => {};
	vi.stubGlobal('IntersectionObserver', class {
		constructor(callback: typeof report) {
			report = callback;
		}
		observe() {}
		disconnect() {}
	});
	const scrolled = vi.fn();
	Element.prototype.scrollIntoView = scrolled;
	show({
		messages: [said('user', '/remember tea', 'u'), {
			id: 'a', role: 'assistant',
			parts: [{ type: 'dynamic-tool', toolName: 'remember', toolCallId: 'c', state: 'approval-requested', input: { fact: 'tea' }, approval: { id: 'x' } }],
		} as ChatMessage],
	});
	expect(screen.queryByRole('button', { name: /waiting for your approval/ })).toBeNull();
	act(() => report([{ isIntersecting: false }]));
	fireEvent.click(screen.getByRole('button', { name: /waiting for your approval/ }));
	expect(scrolled).toHaveBeenCalled();
});

it('edits the owner’s message in place and retries the last reply, saying the message again', async () => {
	const bodies: Record<string, unknown>[] = [];
	const view = show({ messages: [said('user', 'first', 'u1'), said('assistant', 'one', 'a1'), said('user', 'second', 'u2'), said('assistant', 'two', 'a2')] });
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith('/chat')) {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response('data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
		}
		return Response.json({ messages: [said('user', 'first', 'u1'), said('assistant', 'one', 'a1')], active: false, model: 'demo/echo' });
	}));
	// Only the last reply can be asked for again.
	expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
	expect(screen.getAllByRole('button', { name: 'Edit message' })).toHaveLength(2);
	fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[1]);
	const editor = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement;
	expect(editor.value).toBe('second');
	expect((within(editor.form!).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
	fireEvent.keyDown(editor, { key: 'Escape' });
	expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
	fireEvent.click(screen.getAllByRole('button', { name: 'Edit message' })[1]);
	const again = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement;
	fireEvent.change(again, { target: { value: 'second, better' } });
	fireEvent.click(within(again.form!).getByRole('button', { name: 'Send' }));
	await waitFor(() => expect(bodies).toHaveLength(1));
	expect(bodies[0]).toMatchObject({ replace: 'u2', text: 'second, better' });
	expect(view.container.textContent).not.toContain('two');
	await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
	fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
	await waitFor(() => expect(bodies).toHaveLength(2));
	expect(bodies[1]).toMatchObject({ replace: 'u1', text: 'first' });
});

it('retries a reply only when it answers the owner’s message, not a command', () => {
	const command = (m: ChatMessage) => ({ ...m, metadata: { command: true } }) as ChatMessage;
	expect(askedBy([said('user', 'hi', 'u'), said('assistant', 'hello', 'a')])?.id).toBe('u');
	expect(askedBy([said('user', 'hi', 'u')])).toBeUndefined();
	expect(askedBy([command(said('user', '/list', 'u')), command(said('assistant', 'One', 'a'))])).toBeUndefined();
	expect(askedBy([said('assistant', 'Reminder', 'a')])).toBeUndefined();
});
