import { describe, it, expect } from 'vitest';
import {
	DeepTasks,
	DEEP_TASK_MAX_STEPS,
	DEEP_TASK_WALL_CLOCK_MS,
	composeDeepTaskDelivery,
	deepTaskCancelCallbackData,
	parseDeepTaskCallback,
	renderDeepTaskProgress,
	renderDeepTaskSettled,
	splitForTelegram,
	type DeepTaskStore,
	type StoredDeepTask,
} from '../features/agent/deep-tasks';

/** In-memory pinned-row `DeepTaskStore` — the DO SQLite stand-in for unit tests. */
function fakeStore(): DeepTaskStore & { row: () => StoredDeepTask | null } {
	let stored: StoredDeepTask | null = null;
	return {
		row: () => stored,
		get: () => stored,
		put: (task) => void (stored = task),
		clear: () => void (stored = null),
	};
}

/** A module under test with a settable clock and deterministic ids. */
function makeTasks(overrides: { maxSteps?: number; wallClockMs?: number } = {}) {
	const store = fakeStore();
	let nowMs = 1_000_000;
	let seq = 0;
	const tasks = new DeepTasks({
		store,
		now: () => nowMs,
		newId: () => `task-${++seq}`,
		...overrides,
	});
	return { tasks, store, advance: (ms: number) => (nowMs += ms) };
}

/**
 * Tests the **Deep task** core (docs/adr/0040, PRD #99): single-slot exclusivity,
 * the step/wall-clock budget gates, cancel/timeout partial-result semantics,
 * delivery composition (never silently discards work), the Telegram splitter,
 * and the cancel-callback codec. Pure module + in-memory pinned row + fixed
 * clock — no DO, no fiber, no model.
 */
describe('DeepTasks — single-slot exclusivity', () => {
	it('claims the slot on first start; refuses a second start, naming the running task', () => {
		const { tasks } = makeTasks();
		const first = tasks.start({ description: 'research X', prompt: 'do X', startedBy: 42 });
		expect('task' in first).toBe(true);
		const second = tasks.start({ description: 'research Y', prompt: 'do Y', startedBy: 42 });
		expect('error' in second && second.error.includes('research X')).toBe(true);
	});
});

describe('DeepTasks — budget gates', () => {
	it('a fresh run is allowed; the step cap, wall clock, and cancellation gate the loop', () => {
		const { tasks, advance } = makeTasks({ maxSteps: 2 });
		tasks.start({ description: 'd', prompt: 'p', startedBy: 42 });
		expect(tasks.beginStep().allowed).toBe(true);

		tasks.recordStep('web_search');
		tasks.recordStep('fetch_url');
		const capped = tasks.beginStep();
		expect(!capped.allowed && capped.reason === 'step-cap').toBe(true);

		const { tasks: t2, advance: advance2 } = makeTasks();
		t2.start({ description: 'd', prompt: 'p', startedBy: 42 });
		advance2(DEEP_TASK_WALL_CLOCK_MS + 1);
		const timedOut = t2.beginStep();
		expect(!timedOut.allowed && timedOut.reason === 'timeout').toBe(true);

		const { tasks: t3 } = makeTasks();
		t3.start({ description: 'd', prompt: 'p', startedBy: 42 });
		expect(t3.requestCancel()).toBe(true);
		const cancelled = t3.beginStep();
		expect(!cancelled.allowed && cancelled.reason === 'cancelled').toBe(true);
		void advance;
	});
});

describe('DeepTasks — recordStep and attachStartMessage', () => {
	it('bumps steps and current phase; a null phase keeps the last one; the start message id is persisted', () => {
		const { tasks, store } = makeTasks();
		tasks.start({ description: 'd', prompt: 'p', startedBy: 42 });
		tasks.attachStartMessage(777);
		const updated = tasks.recordStep('web_search');
		expect(updated?.stepsDone === 1 && updated.phase === 'web_search').toBe(true);
		const kept = tasks.recordStep(null);
		expect(kept?.stepsDone === 2 && kept.phase === 'web_search').toBe(true);
		expect(store.row()?.startMessageId).toBe(777);
	});
});

describe('DeepTasks — finish / requestCancel', () => {
	it('finish releases the slot; the slot is reusable after finish; requestCancel on no running task is false', () => {
		const { tasks } = makeTasks();
		expect(tasks.requestCancel()).toBe(false);
		tasks.start({ description: 'd', prompt: 'p', startedBy: 42 });
		tasks.finish();
		expect(tasks.snapshot()).toBeNull();
		expect('task' in tasks.start({ description: 'd2', prompt: 'p2', startedBy: 42 })).toBe(true);
	});
});

describe('composeDeepTaskDelivery', () => {
	it('a completed run delivers the report verbatim; the session user message is provenance-wrapped; the session assistant message is the report', () => {
		const completed = composeDeepTaskDelivery({ description: 'd', prompt: 'p', body: 'The report.', end: 'completed' });
		expect(completed.messages[0]).toBe('The report.');
		expect(completed.sessionUser).toBe('[deep task: d] p');
		expect(completed.sessionAssistant).toBe('The report.');
	});

	it('a cancelled run is framed as partial and delivers partials, not blank slates', () => {
		const cancelled = composeDeepTaskDelivery({ description: 'd', prompt: 'p', body: 'Partial.', end: 'cancelled' });
		expect(cancelled.messages[0].startsWith('✖️ Task cancelled')).toBe(true);
		expect(cancelled.messages[0].includes('Partial.')).toBe(true);
	});

	it('a timeout names the 15-minute limit', () => {
		const timeout = composeDeepTaskDelivery({ description: 'd', prompt: 'p', body: 'Partial.', end: 'timeout' });
		expect(timeout.messages[0].includes('15-minute')).toBe(true);
	});

	it('an error run includes the error', () => {
		const errored = composeDeepTaskDelivery({ description: 'd', prompt: 'p', body: 'Partial.', end: 'error', error: 'boom' });
		expect(errored.messages[0].includes('boom')).toBe(true);
	});

	it('an empty body still delivers an honest line', () => {
		const empty = composeDeepTaskDelivery({ description: 'd', prompt: 'p', body: '  ', end: 'cancelled' });
		expect(empty.messages[0].includes('no text')).toBe(true);
	});
});

describe('splitForTelegram (the Telegram splitter)', () => {
	it('passes short text through (one chunk)', () => {
		expect(splitForTelegram('short').length).toBe(1);
	});

	it('splits long text at boundaries under the cap; no content lost', () => {
		const paragraph = 'x'.repeat(1000);
		const long = Array.from({ length: 10 }, () => paragraph).join('\n\n');
		const chunks = splitForTelegram(long);
		expect(chunks.length > 1).toBe(true);
		expect(chunks.every((c) => c.length <= 4096)).toBe(true);
		expect(chunks.join('').replace(/\s/g, '').length === long.replace(/\s/g, '').length).toBe(true);
	});
});

describe('DeepTasks — renderers and cancel codec', () => {
	it('progress, settled line, and the cancel callback codec', () => {
		const { tasks } = makeTasks();
		const started = tasks.start({ description: 'research X', prompt: 'p', startedBy: 42 });
		expect('task' in started).toBe(true);
		if ('task' in started) {
			const fresh = renderDeepTaskProgress(started.task);
			expect(fresh.text).toBe('🔬 research X');
			tasks.recordStep('web_search');
			const progressed = renderDeepTaskProgress(tasks.snapshot() as StoredDeepTask);
			expect(progressed.text).toBe(`🔬 research X · step 1/${DEEP_TASK_MAX_STEPS} · web_search`);
			expect(progressed.keyboard[0][0].callback_data).toBe(deepTaskCancelCallbackData(started.task.id));
		}
		expect(renderDeepTaskSettled('research X', 'completed')).toBe('🔬 research X · ✅ done');
		expect(renderDeepTaskSettled('research X', 'timeout').includes('⌛')).toBe(true);

		const parsed = parseDeepTaskCallback(deepTaskCancelCallbackData('task-9'));
		expect(parsed?.id).toBe('task-9');
		expect(parseDeepTaskCallback('apr:y:x')).toBeNull();
		expect(parseDeepTaskCallback(undefined)).toBeNull();
	});
});