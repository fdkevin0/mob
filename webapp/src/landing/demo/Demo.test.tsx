import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DemoPage } from './DemoPage';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Each act flushes one round of renders, so time passes in small steps.
const wait = async (ms: number) => { for (let t = 0; t < ms; t += 100) await act(async () => { await vi.advanceTimersByTimeAsync(100); }); };

function play() {
	vi.useFakeTimers();
	// Without an observer the demo counts as on screen.
	vi.stubGlobal('IntersectionObserver', undefined);
	render(<DemoPage />);
}

it('moves the conversation and the agents together, and takes an approval from the conversation', async () => {
	play();
	// Touching the demo stops the autopilot, so the approval waits for the visitor.
	fireEvent.click(screen.getByRole('button', { name: 'Web app' }));
	await wait(11_000);
	const chat = within(screen.getByRole('region', { name: 'The conversation' }));
	const agents = within(screen.getByRole('region', { name: 'Agents' }));
	expect(chat.getByText(/wants to run a command in the sandbox/)).toBeTruthy();
	expect(agents.getByText('Run command · in the sandbox')).toBeTruthy();
	fireEvent.click(chat.getByRole('button', { name: 'Allow once' }));
	// The agent card stops asking as soon as the conversation answers.
	expect(agents.queryByText('Run command · in the sandbox')).toBeNull();
	await wait(14_000);
	expect(agents.getByRole('status').textContent).toMatch(/Both branches are ready to merge/);
	expect(chat.getByText(/Want me to open the pull requests/)).toBeTruthy();
});

it('takes a denial from the agent card and from a chat app', async () => {
	play();
	fireEvent.click(screen.getByRole('button', { name: 'Chat app' }));
	await wait(11_000);
	const phone = within(screen.getByLabelText('Mob in a chat app'));
	expect(phone.getByText(/Codex wants to run a command/)).toBeTruthy();
	fireEvent.click(within(screen.getByRole('region', { name: 'Agents' })).getByRole('button', { name: 'Deny' }));
	expect(phone.getByText('✗ Denied')).toBeTruthy();
	await wait(14_000);
	expect(phone.getByText(/run it before you merge mob\/flaky-t1/)).toBeTruthy();
});

it('reports a stopped agent as stopped, not ready to merge', async () => {
	play();
	fireEvent.click(screen.getByRole('button', { name: 'Web app' }));
	await wait(11_000);
	const agents = within(screen.getByRole('region', { name: 'Agents' }));
	fireEvent.click(agents.getByRole('button', { name: /Codex/ }));
	fireEvent.click(agents.getByRole('button', { name: 'Stop Codex' }));
	await wait(14_000);
	expect(agents.getByRole('status').textContent).toMatch(/1 of 2 branches ready to merge/);
	const chat = within(screen.getByRole('region', { name: 'The conversation' }));
	expect(chat.getByText(/You stopped/)).toBeTruthy();
	expect(chat.queryByText(/Both are ready/)).toBeNull();
});

it('leaves the conversation where the visitor scrolled it', async () => {
	play();
	fireEvent.click(screen.getByRole('button', { name: 'Web app' }));
	await wait(4_000);
	const box = screen.getByRole('region', { name: 'The conversation' }).querySelector<HTMLElement>('.d-scroll')!;
	// happy-dom has no layout, so give the box one.
	Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 1000 });
	Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 300 });
	box.scrollTop = 0;
	fireEvent.scroll(box);
	await wait(1_000);
	expect(box.scrollTop).toBe(0);
});
