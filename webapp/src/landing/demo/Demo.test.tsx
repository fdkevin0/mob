import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Demo } from './Demo';
import { decide, finish, scenarios, shownAnswer, start, tick, visible, type State } from './script';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Each act flushes one round of renders, so time passes in small steps.
const wait = async (ms: number) => { for (let t = 0; t < ms; t += 100) await act(async () => { await vi.advanceTimersByTimeAsync(100); }); };
const playTo = (s: State, until: (s: State) => boolean) => { while (!until(s)) s = tick(s); return s; };

it('stops every task once for an approval', () => {
	for (const [i, sc] of scenarios.entries()) {
		expect(sc.steps.filter(s => s.kind === 'approve')).toHaveLength(1);
		const s = playTo(start(i), s => s.phase === 'wait');
		expect(tick(s)).toBe(s);
		expect(visible(s).at(-1)?.status).toBe('waiting');
	}
});

it('answers either way the approval goes', () => {
	for (const i of scenarios.keys()) {
		const allowed = finish(i, 'allow');
		expect(shownAnswer(allowed)).toBe(scenarios[i].answer);
		expect(visible(allowed).every(v => v.status === 'done')).toBe(true);
		const denied = finish(i, 'deny');
		expect(shownAnswer(denied)).toBe(scenarios[i].denied);
		expect(visible(denied).at(-1)?.status).toBe('denied');
		// Nothing after the denied step runs.
		expect(visible(denied).length).toBeLessThanOrEqual(scenarios[i].steps.length);
	}
	const waiting = playTo(start(1), s => s.phase === 'wait');
	expect(visible(decide(waiting, 'deny')).map(v => v.step.kind)).toEqual(['think', 'tool', 'tool', 'approve']);
});

it('lets the visitor pick a task and deny the approval', async () => {
	vi.useFakeTimers();
	// Without an observer the demo counts as on screen.
	vi.stubGlobal('IntersectionObserver', undefined);
	render(<Demo />);
	fireEvent.click(within(screen.getByRole('group', { name: 'Tasks' })).getByRole('button', { name: 'Failing checkout tests' }));
	await wait(20_000);
	// Taking over stops the autopilot, so the approval waits for a click.
	const deny = screen.getAllByRole('button', { name: 'Deny' });
	expect(deny.length).toBeGreaterThan(0);
	fireEvent.click(deny[0]);
	await wait(10_000);
	expect(screen.getAllByText(/Left your files alone/)).toHaveLength(2); // the app and Telegram
	expect(screen.getByRole('button', { name: 'Replay' })).toBeTruthy();
});
