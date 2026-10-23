import { expect, it } from 'vitest';
import { begin, decide, finish, report, reported, stop, tasks, view, waitingFor, type Run } from './orchestra';

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
		expect(view(end, tasks[0])!.log.at(-1)).toMatch(d === 'deny' ? /1 of 2 branches ready/ : /both branches are ready/);
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

const byId = (id: string) => tasks.find(t => t.id === id)!;

it('reports a stopped branch as stopped, not ready', () => {
	// Stop Codex while it waits for the approval.
	const run = stop(at(begin(), asking.waits!.at + 1), asking.id);
	const end = at(run, reported(run));
	expect(status(end, asking.id)).toBe('stopped');
	const r = report(end, 0);
	expect(r.ready).toBe(1);
	expect(r.banner).toBe('1 of 2 branches ready to merge');
	expect(r.lead).toMatch(/You stopped `mob\/flaky-t1`/);
	expect(r.brief).not.toMatch(/Both branches/);
	expect(view(end, tasks[0])!.log.join('\n')).not.toMatch(/every branch/);
});

it('freezes a stopped agent where it was, and skips what it never started', () => {
	const t2 = byId('t2');
	const run = stop(at(begin(), 3), t2.id);
	const late = at(run, 30);
	expect(view(late, t2)!.log).not.toContain('Merged the fix into retry-t2');
	// Its subtasks never ran, and nothing failed, so nothing was retried.
	expect(view(late, byId('t5'))).toBeUndefined();
	expect(view(late, byId('t7'))).toBeUndefined();
	expect(view(late, tasks[0])!.log.join('\n')).not.toMatch(/failed/);
});

it('does not retry a task stopped before it failed, and says part was stopped', () => {
	const run = stop(at(begin(), 7), 't5');
	const done = decide(at(run, asking.waits!.at + 0.5), 'allow');
	const end = at(done, reported(done));
	expect(view(end, byId('t7'))).toBeUndefined();
	expect(status(end, 't2')).toBe('review');
	expect(report(end, 0).results).toEqual(['50 of 50 runs pass', 'Partly stopped, not checked']);
});

it('keeps finished work done when the agent above it is stopped later', () => {
	const run = stop(at(begin(), byId('t3').end + 0.5), 't1');
	expect(status(at(run, 20), 't3')).toBe('review');
	expect(status(at(run, 20), 't1')).toBe('stopped');
});
