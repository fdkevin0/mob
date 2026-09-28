import { describe, it, expect } from 'vitest';
import type { Env } from '../core/env';
import { buildBuiltinTools, builtinToolSummaries, builtinToolLabels } from '../features/agent/tools';
import { scheduleTurnTool, listScheduledTool, cancelScheduledTool } from '../features/agent/tools/schedule-tools';
import {
	ScheduledTurns,
	type ScheduledTurnStore,
	type StoredScheduledTurn,
} from '../features/agent/scheduled-turns';
import { Memory } from '../features/memory/memory';

/** Invoke an AI-SDK tool's execute with a minimal options bag. */
async function run(tool: any, args: unknown): Promise<any> {
	return tool.execute(args, { toolCallId: 't', messages: [] });
}

function fakeStore(): ScheduledTurnStore {
	const rows = new Map<string, StoredScheduledTurn>();
	return {
		upsert: (t) => void rows.set(t.id, t),
		getById: (id) => rows.get(id) ?? null,
		list: () => [...rows.values()],
		deleteById: (id) => void rows.delete(id),
	};
}

function makeTurns(): ScheduledTurns {
	let seq = 0;
	return new ScheduledTurns({
		store: fakeStore(),
		scheduler: { register: async () => {}, cancelPending: async () => {} },
		now: () => new Date('2026-07-02T10:00:00Z'),
		defaultTimezone: 'Europe/London',
		newId: () => `task-${++seq}`,
	});
}

/** Minimal non-tool deps for `buildBuiltinTools` in gating tests. */
function fakeBuiltinDeps() {
	const memory = new Memory({
		chatId: 1,
		store: { insert() {}, update() {}, listIds: () => [], listAll: () => [], getByIds: () => [], deleteByIds() {}, deleteAll() {} },
		index: { async upsert() {}, async query() { return []; }, async deleteByIds() {} },
		embed: async () => [0],
	});
	const sandbox = {
		runCode: async () => ({ logs: { stdout: [], stderr: [] }, results: [] }),
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
	};
	return { memory, sandbox };
}

/**
 * Tests the **Scheduled turn** tool trio (docs/adr/0028): `schedule_turn` /
 * `list_scheduled` / `cancel_scheduled` over a `ScheduledTurns` core with fakes,
 * the transcript label/summary hooks, and the admin gating in `buildBuiltinTools`.
 */
describe('schedule_turn tool', () => {
	it('creates a recurring turn and echoes the next fire + timezone', async () => {
		const turns = makeTurns();
		const t = scheduleTurnTool(turns);
		const out = await run(t, {
			prompt: 'Summarize my feeds',
			description: 'morning briefing',
			when: { recurrence: '0 8 * * *' },
		});
		expect(out.scheduled).toBe(true);
		expect(typeof out.id).toBe('string');
		expect(out.next).toBe('2026-07-03T07:00:00.000Z'); // echoes the resolved next fire (BST)
		expect(out.timezone).toBe('Europe/London');
	});

	it('returns a soft error for a past instant and for sub-15-minute recurrences', async () => {
		const turns = makeTurns();
		const t = scheduleTurnTool(turns);
		const past = await run(t, { prompt: 'p', description: 'd', when: { at: '2020-01-01T00:00:00Z' } });
		expect(typeof past.error).toBe('string');
		const tooOften = await run(t, { prompt: 'p', description: 'd', when: { recurrence: '* * * * *' } });
		expect(typeof tooOften.error === 'string' && /15/.test(tooOften.error)).toBe(true);
	});
});

describe('list_scheduled tool', () => {
	it('lists tasks with description, recurrence, and next fire ISO', async () => {
		const turns = makeTurns();
		await run(scheduleTurnTool(turns), { prompt: 'p', description: 'briefing', when: { recurrence: '0 8 * * *' } });
		const out = await run(listScheduledTool(turns), {});
		expect(Array.isArray(out.tasks) && out.tasks.length === 1).toBe(true);
		expect(out.tasks[0].description).toBe('briefing');
		expect(out.tasks[0].recurrence).toBe('0 8 * * *');
		expect(typeof out.tasks[0].next).toBe('string');
	});

	it('an empty list is a normal empty result', async () => {
		const empty = await run(listScheduledTool(makeTurns()), {});
		expect(Array.isArray(empty.tasks) && empty.tasks.length === 0).toBe(true);
	});
});

describe('cancel_scheduled tool', () => {
	it('cancels by id; unknown id returns a soft error', async () => {
		const turns = makeTurns();
		const created = await run(scheduleTurnTool(turns), { prompt: 'p', description: 'd', when: { recurrence: '0 8 * * *' } });
		const out = await run(cancelScheduledTool(turns), { id: created.id });
		expect(out.cancelled).toBe(true);
		const missing = await run(cancelScheduledTool(turns), { id: 'nope' });
		expect(typeof missing.error).toBe('string');
	});
});

describe('buildBuiltinTools admin gating', () => {
	/** The trio is registered only when the factory gets a `scheduledTurns` dep (the admin's chat). */
	it('absent without the dep; present with it', async () => {
		const env = { AI: { toMarkdown: async () => [{ data: '' }] }, BOT_TIMEZONE: 'UTC' } as unknown as Env;
		const deps = fakeBuiltinDeps();

		const without = buildBuiltinTools(env, deps);
		expect('schedule_turn' in without).toBe(false);
		expect('list_scheduled' in without).toBe(false);
		expect('cancel_scheduled' in without).toBe(false);

		const withTurns = buildBuiltinTools(env, { ...deps, scheduledTurns: makeTurns() });
		expect('schedule_turn' in withTurns).toBe(true);
		expect('list_scheduled' in withTurns).toBe(true);
		expect('cancel_scheduled' in withTurns).toBe(true);
	});
});

describe('transcript label/summary hooks', () => {
	it('schedule_turn label uses the description; summary shows next fire and relays soft errors', () => {
		expect(builtinToolLabels.schedule_turn({ description: 'morning briefing' })).toBe('morning briefing');
		expect(
			builtinToolSummaries.schedule_turn({ scheduled: true, next: '2026-07-03T07:00:00.000Z' }).includes('2026-07-03')
		).toBe(true);
		expect(builtinToolSummaries.schedule_turn({ error: 'limit reached' })).toBe('limit reached');
	});

	it('list_scheduled summary counts (singular vs plural)', () => {
		expect(builtinToolSummaries.list_scheduled({ tasks: [1, 2] })).toBe('2 tasks');
		expect(builtinToolSummaries.list_scheduled({ tasks: [1] })).toBe('1 task');
	});

	it('cancel_scheduled summary relays the result', () => {
		expect(builtinToolSummaries.cancel_scheduled({ cancelled: true })).toBe('cancelled');
	});
});
