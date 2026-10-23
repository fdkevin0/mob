import { expect, it } from 'vitest';
import { begin, decide, finish, reported, stop, tasks, view, waitingFor, type Run } from './orchestra';

const at = (run: Run, t: number): Run => ({ ...run, t });
const status = (run: Run, id: string) => view(run, tasks.find(t => t.id === id)!)?.status;
const asking = tasks.find(t => t.waits)!;

it('waits on the approval until someone decides', () => {
	const run = at(begin(), 60);
	expect(waitingFor(run)?.id).toBe(asking.id);
	expect(reported(run)).toBe(Infinity);
	expect(status(run, 'mob')).toBe('running');
	// Everything else finishes meanwhile, the failed task included.
	expect(tasks.filter(t => t.id !== 'mob' && t !== asking).map(t => status(run, t.id))).toEqual(tasks.filter(t => t.id !== 'mob' && t !== asking).map(t => t.failed ? 'failed' : 'review'));
});

it('reports once every branch is done, either way the approval goes', () => {
	for (const d of ['allow', 'deny'] as const) {
		const decided = decide(at(begin(), asking.waits!.at + 1), d);
		const end = at(decided, reported(decided));
		expect(status(end, asking.id)).toBe('review');
		expect(status(end, 'mob')).toBe('idle');
		expect(view(end, tasks[0])!.log.at(-1)).toMatch(d === 'deny' ? /waits for your test run/ : /both branches ready/);
	}
	expect(view(finish(), tasks[0])!.status).toBe('idle');
});

it('stops an agent and the ones under it', () => {
	const parent = tasks.find(t => tasks.some(c => c.parent === t.id) && t.id !== 'mob' && !t.waits)!;
	const child = tasks.find(t => t.parent === parent.id)!;
	const run = stop(at(begin(), child.start + 0.5), parent.id);
	expect(status(at(run, child.start + 1), parent.id)).toBe('stopped');
	expect(status(at(run, child.start + 1), child.id)).toBe('stopped');
	expect(decide(at(begin(), 1), 'allow').decided).toBeUndefined();
});
