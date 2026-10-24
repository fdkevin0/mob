import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage, Snapshot } from './api';
import { Thread, quiet } from './Thread';

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

it('says it is working only while nothing else shows Mob at work', () => {
	const tool = (state: string) => ({ id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 'c', state, input: {} }] }) as ChatMessage;
	expect(quiet(said('user', 'hi'))).toBe(false);
	expect(quiet({ id: 'a', role: 'assistant', parts: [] } as ChatMessage)).toBe(false);
	expect(quiet(said('assistant', 'Hel'))).toBe(true);
	expect(quiet(tool('input-available'))).toBe(true);
	expect(quiet(tool('approval-requested'))).toBe(true);
	expect(quiet(tool('output-available'))).toBe(false);
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
