import { describe, it, expect, vi } from 'vitest';
import {
	ScheduledTurns,
	cancelPendingTurnAlarms,
	MAX_ACTIVE_SCHEDULED_TURNS,
	type ScheduledTurnStore,
	type OccurrenceScheduler,
	type StoredScheduledTurn,
} from '../features/agent/scheduled-turns';

/** In-memory `ScheduledTurnStore` — the DO SQLite stand-in for unit tests. */
function fakeStore(): ScheduledTurnStore & { rows: Map<string, StoredScheduledTurn> } {
	const rows = new Map<string, StoredScheduledTurn>();
	return {
		rows,
		upsert: (t) => void rows.set(t.id, t),
		getById: (id) => rows.get(id) ?? null,
		list: () => [...rows.values()],
		deleteById: (id) => void rows.delete(id),
	};
}

/** In-memory `OccurrenceScheduler` — records registrations in call order. */
function fakeScheduler(): OccurrenceScheduler & { registered: Array<{ taskId: string; at: number }>; cancelled: string[] } {
	const registered: Array<{ taskId: string; at: number }> = [];
	const cancelled: string[] = [];
	return {
		registered,
		cancelled,
		register: async (taskId, at) => void registered.push({ taskId, at: at.getTime() }),
		cancelPending: async (taskId) => void cancelled.push(taskId),
	};
}

/** A module under test with fixed clock, deterministic ids, and fakes. */
function makeTurns(nowIso: string) {
	const store = fakeStore();
	const scheduler = fakeScheduler();
	let seq = 0;
	const turns = new ScheduledTurns({
		store,
		scheduler,
		now: () => new Date(nowIso),
		defaultTimezone: 'Europe/London',
		newId: () => `task-${++seq}`,
	});
	return { turns, store, scheduler };
}

/**
 * Tests the **Scheduled turn** core (docs/adr/0028): create/list/cancel, the
 * local-time DST-correct recurrence via croner, reschedule-before-run, and the
 * dumb guardrails (cap, minimum recurrence, visible failures). Pure module +
 * in-memory fakes + fixed clock — no DO, no SDK.
 */
describe('ScheduledTurns.create — one-off', () => {
	it('stores a one-off and registers a single occurrence', async () => {
		const { turns, scheduler } = makeTurns('2026-07-02T10:00:00Z');
		const result = await turns.create({
			prompt: 'Remind me: renew the visa',
			description: 'visa reminder',
			when: { at: '2026-07-03T09:00:00Z' },
		});
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.task.when.kind).toBe('once');
		expect(result.next.toISOString()).toBe('2026-07-03T09:00:00.000Z');
		expect(scheduler.registered.length).toBe(1);
		expect(scheduler.registered[0].taskId).toBe(result.task.id);

		const listed = turns.list();
		expect(listed.length === 1 && listed[0].description === 'visa reminder').toBe(true);
		expect(listed[0].next?.getTime() === result.next.getTime()).toBe(true);
	});

	it('rejects a past instant and an unparseable instant as a soft error (nothing stored)', async () => {
		const { turns, scheduler } = makeTurns('2026-07-02T10:00:00Z');
		const past = await turns.create({ prompt: 'p', description: 'd', when: { at: '2026-07-01T09:00:00Z' } });
		expect('error' in past).toBe(true);
		const garbage = await turns.create({ prompt: 'p', description: 'd', when: { at: 'not-a-date' } });
		expect('error' in garbage).toBe(true);
		expect(scheduler.registered.length).toBe(0);
		expect(turns.list().length).toBe(0);
	});
});

describe('ScheduledTurns.create — when validation', () => {
	it('rejects neither-at-nor-recurrence and both-at-and-recurrence as soft errors', async () => {
		const { turns } = makeTurns('2026-07-02T10:00:00Z');
		const neither = await turns.create({ prompt: 'p', description: 'd', when: {} });
		expect('error' in neither).toBe(true);
		const both = await turns.create({
			prompt: 'p',
			description: 'd',
			when: { at: '2026-07-03T09:00:00Z', recurrence: '0 8 * * *' },
		});
		expect('error' in both).toBe(true);
	});
});

describe('ScheduledTurns.create — recurring & DST', () => {
	/** Winter (GMT): 08:00 Europe/London = 08:00 UTC. */
	it('resolves the next winter occurrence in UTC', async () => {
		const { turns } = makeTurns('2026-01-15T10:00:00Z');
		const result = await turns.create({ prompt: 'brief me', description: 'morning briefing', when: { recurrence: '0 8 * * *' } });
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.next.toISOString()).toBe('2026-01-16T08:00:00.000Z');
		expect(result.task.when.kind === 'recurring' && result.task.when.timezone === 'Europe/London').toBe(true);
	});

	/** Summer (BST): 08:00 Europe/London = 07:00 UTC — the DST-correctness the design paid for. */
	it('resolves the next summer occurrence in UTC', async () => {
		const { turns } = makeTurns('2026-07-01T10:00:00Z');
		const result = await turns.create({ prompt: 'brief me', description: 'morning briefing', when: { recurrence: '0 8 * * *' } });
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.next.toISOString()).toBe('2026-07-02T07:00:00.000Z');
	});

	/**
	 * Spring forward (Europe/London, 2026-03-29): local 01:00→02:00, so 01:30 local
	 * does not exist that day. Croner's policy — documented here — is to fire at the
	 * shifted instant (01:30 UTC = 02:30 BST): the task runs once, never doubles,
	 * never silently skips a day, and the following days are back on local time.
	 */
	it('spring-forward fires once at the shifted instant (no double/skip)', async () => {
		const { turns } = makeTurns('2026-03-28T12:00:00Z');
		const result = await turns.create({ prompt: 'p', description: 'd', when: { recurrence: '30 1 * * *' } });
		expect('error' in result).toBe(false);
		if ('error' in result) return;
		expect(result.next.toISOString()).toBe('2026-03-29T01:30:00.000Z');
		const listed = turns.list();
		expect(listed[0].next?.toISOString()).toBe('2026-03-29T01:30:00.000Z');
	});
});

describe('ScheduledTurns.create — guardrails', () => {
	it('rejects an invalid cron and an invalid timezone as soft errors', async () => {
		const { turns } = makeTurns('2026-07-02T10:00:00Z');
		const badCron = await turns.create({ prompt: 'p', description: 'd', when: { recurrence: 'not a cron' } });
		expect('error' in badCron).toBe(true);
		const badTz = await turns.create({ prompt: 'p', description: 'd', when: { recurrence: '0 8 * * *', timezone: 'Mars/Olympus' } });
		expect('error' in badTz).toBe(true);
	});

	it('rejects sub-15-minute recurrences but allows hourly', async () => {
		const { turns } = makeTurns('2026-07-02T10:00:00Z');
		const tooOften = await turns.create({ prompt: 'p', description: 'd', when: { recurrence: '*/5 * * * *' } });
		expect('error' in tooOften && /15/.test((tooOften as { error: string }).error)).toBe(true);
		const hourly = await turns.create({ prompt: 'p', description: 'd', when: { recurrence: '0 * * * *' } });
		expect('error' in hourly).toBe(false);
	});

	it(`caps active turns at ${MAX_ACTIVE_SCHEDULED_TURNS}`, async () => {
		const { turns } = makeTurns('2026-07-02T10:00:00Z');
		for (let i = 0; i < MAX_ACTIVE_SCHEDULED_TURNS; i++) {
			const r = await turns.create({ prompt: `p${i}`, description: `d${i}`, when: { at: `2026-07-03T0${i % 9}:00:00Z` } });
			expect('error' in r).toBe(false);
		}
		const over = await turns.create({ prompt: 'p', description: 'd', when: { at: '2026-07-04T09:00:00Z' } });
		expect('error' in over && /10/.test((over as { error: string }).error)).toBe(true);
	});
});

describe('ScheduledTurns.beginFire', () => {
	/** Reschedule-before-run: the next occurrence is registered by `beginFire`, before the caller runs the turn. */
	it('reschedules a recurring turn before returning, advancing the chain a day', async () => {
		const { turns, scheduler } = makeTurns('2026-07-01T10:00:00Z');
		const created = await turns.create({ prompt: 'brief me', description: 'briefing', when: { recurrence: '0 8 * * *' } });
		if ('error' in created) throw new Error('setup failed');
		expect(scheduler.registered.length).toBe(1);

		// The alarm fires (at 2026-07-02T07:00Z). beginFire must register 03 Jul before returning.
		const fired = await turns.beginFire(created.task.id, new Date('2026-07-02T07:00:00Z'));
		expect(fired).not.toBeNull();
		expect(fired!.task.prompt).toBe('brief me');
		expect(scheduler.registered.length).toBe(2);
		expect(new Date(scheduler.registered[1].at).toISOString()).toBe('2026-07-03T07:00:00.000Z');
		expect(fired!.next?.toISOString()).toBe('2026-07-03T07:00:00.000Z');
	});

	it('one-off has no next occurrence and no re-registration', async () => {
		const { turns, scheduler } = makeTurns('2026-07-02T10:00:00Z');
		const created = await turns.create({ prompt: 'remind', description: 'visa', when: { at: '2026-07-03T09:00:00Z' } });
		if ('error' in created) throw new Error('setup failed');

		const fired = await turns.beginFire(created.task.id, new Date('2026-07-03T09:00:00Z'));
		expect(fired !== null && fired!.next === null).toBe(true);
		expect(scheduler.registered.length).toBe(1);
	});

	it('an unknown id fires nothing (null)', async () => {
		const { turns } = makeTurns('2026-07-02T10:00:00Z');
		const fired = await turns.beginFire('nope', new Date('2026-07-02T11:00:00Z'));
		expect(fired).toBeNull();
	});
});

describe('ScheduledTurns.completeFire', () => {
	it('a successful one-off is removed; a failed recurring stays active with the error visible; a failed one-off is kept and marked failed', async () => {
		const { turns } = makeTurns('2026-07-01T10:00:00Z');
		const oneOff = await turns.create({ prompt: 'p', description: 'one-off', when: { at: '2026-07-02T09:00:00Z' } });
		const recurring = await turns.create({ prompt: 'p', description: 'recurring', when: { recurrence: '0 8 * * *' } });
		if ('error' in oneOff || 'error' in recurring) throw new Error('setup failed');

		// A successful one-off is done — gone from the list.
		await turns.beginFire(oneOff.task.id, new Date('2026-07-02T09:00:00Z'));
		turns.completeFire(oneOff.task.id, { ok: true });
		expect(turns.list().every((t) => t.id !== oneOff.task.id)).toBe(true);

		// A failed recurring stays active (the chain already advanced) with the error visible.
		turns.completeFire(recurring.task.id, { ok: false, error: 'model exploded' });
		const rec = turns.list().find((t) => t.id === recurring.task.id);
		expect(rec !== undefined && rec.status === 'active').toBe(true);
		expect(rec!.lastError).toBe('model exploded');

		// A failed one-off is kept, marked failed, for conversational re-run.
		const oneOff2 = await turns.create({ prompt: 'p', description: 'one-off-2', when: { at: '2026-07-02T10:00:00Z' } });
		if ('error' in oneOff2) throw new Error('setup failed');
		turns.completeFire(oneOff2.task.id, { ok: false, error: 'boom' });
		const failed = turns.list().find((t) => t.id === oneOff2.task.id);
		expect(failed !== undefined && failed.status === 'failed' && failed.lastError === 'boom').toBe(true);
		expect(failed!.next).toBeNull();
	});
});

describe('ScheduledTurns.cancel', () => {
	it('cancels a task and its pending occurrence; unknown id reports false', async () => {
		const { turns, scheduler } = makeTurns('2026-07-01T10:00:00Z');
		const created = await turns.create({ prompt: 'p', description: 'd', when: { recurrence: '0 8 * * *' } });
		if ('error' in created) throw new Error('setup failed');

		const ok = await turns.cancel(created.task.id);
		expect(ok).toBe(true);
		expect(turns.list().length).toBe(0);
		expect(scheduler.cancelled.includes(created.task.id)).toBe(true);

		const missing = await turns.cancel('nope');
		expect(missing).toBe(false);
	});

	/**
	 * Regression for a real bug found in code review: in production, `deleteById`
	 * (the task row) and `cancelPending` (the SDK alarm lookup) both read/write a
	 * *shared* side table — `deleteById` wipes it as part of dropping the task row.
	 * If `cancel()` deletes the row before asking the scheduler to cancel, the
	 * lookup finds nothing and the underlying alarm is never actually cancelled.
	 * This fake models that coupling (unlike `fakeStore`/`fakeScheduler` above,
	 * which are fully independent) so the ordering fix is locked in at this seam,
	 * not just in the DO wiring.
	 */
	it('cancels the underlying alarm before deleting the row (ordering regression)', async () => {
		const pendingAlarms = new Map<string, string>(); // taskId -> a fake SDK schedule id
		const cancelledAlarms: string[] = [];
		const rows = new Map<string, StoredScheduledTurn>();

		const store: ScheduledTurnStore = {
			upsert: (t) => void rows.set(t.id, t),
			getById: (id) => rows.get(id) ?? null,
			list: () => [...rows.values()],
			deleteById: (id) => {
				rows.delete(id);
				pendingAlarms.delete(id); // mirrors the production `deleteById`'s cross-cutting delete
			},
		};
		const scheduler: OccurrenceScheduler = {
			register: async (taskId) => void pendingAlarms.set(taskId, `sdk-${taskId}`),
			cancelPending: async (taskId) => {
				const scheduleId = pendingAlarms.get(taskId);
				if (scheduleId) cancelledAlarms.push(scheduleId); // only reachable if the row still exists
			},
		};

		let seq = 0;
		const turns = new ScheduledTurns({
			store,
			scheduler,
			now: () => new Date('2026-07-01T10:00:00Z'),
			newId: () => `task-${++seq}`,
		});

		const created = await turns.create({ prompt: 'p', description: 'd', when: { recurrence: '0 8 * * *' } });
		if ('error' in created) throw new Error('setup failed');

		await turns.cancel(created.task.id);
		expect(cancelledAlarms.length).toBe(1);
	});
});
describe('SDK scheduled-turn cancellation', () => {
	it('cancels all matching occurrences without a mapping table and preserves unrelated schedules', async () => {
		const schedules = [
			{ id: 'old', callback: 'onScheduledTurnAlarm', payload: { taskId: 'task-1' } },
			{ id: 'duplicate', callback: 'onScheduledTurnAlarm', payload: { taskId: 'task-1' } },
			{ id: 'other-task', callback: 'onScheduledTurnAlarm', payload: { taskId: 'task-2' } },
			{ id: 'other-callback', callback: 'maintenance', payload: { taskId: 'task-1' } },
			{ id: 'no-payload', callback: 'onScheduledTurnAlarm', payload: null },
		].map((schedule) => ({ ...schedule, type: 'scheduled' as const, time: 2000000000 }));
		const agent = {
			listSchedules: async () => schedules,
			cancelSchedule: vi.fn(async () => true),
		};
		await cancelPendingTurnAlarms(agent, 'task-1');
		expect(agent.cancelSchedule.mock.calls).toEqual([['old'], ['duplicate']]);
		agent.cancelSchedule.mockClear();
		await cancelPendingTurnAlarms(agent, 'missing');
		expect(agent.cancelSchedule).not.toHaveBeenCalled();
	});

	it('propagates cancellation failure so replacement registration cannot continue', async () => {
		const agent = {
			listSchedules: async () => [{
				id: 'old', callback: 'onScheduledTurnAlarm', payload: { taskId: 'task-1' },
				type: 'scheduled' as const, time: 2000000000,
			}],
			cancelSchedule: async () => { throw new Error('cancel failed'); },
		};
		await expect(cancelPendingTurnAlarms(agent, 'task-1')).rejects.toThrow('cancel failed');
	});
});
