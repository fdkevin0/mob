/** Deep-task slot lifecycle, budgets, and partial-result composition; the agent owns the background loop. See docs/adr/0040. */
import type * as Telegram from 'telegram-bot-api-types';
import type { CallbackFamily } from '../../core/callback-family';

/** Own step budget for a deep task's loop (docs/adr/0040): 4× the front turn's 5. */
export const DEEP_TASK_MAX_STEPS = 20;

/** Wall-clock ceiling; hitting it delivers partial results marked incomplete. */
export const DEEP_TASK_WALL_CLOCK_MS = 15 * 60 * 1000;

/** Telegram `sendMessage` hard cap — the delivery splitter's chunk bound. */
const TELEGRAM_TEXT_LIMIT = 4096;

/** How a finished run ended — drives the delivery framing. */
export type DeepTaskEnd = 'completed' | 'cancelled' | 'timeout' | 'error' | 'interrupted';

/** The single pinned deep-task slot (docs/adr/0040: one per chat at a time). */
export interface StoredDeepTask {
	id: string;
	description: string;
	prompt: string;
	/** The initiating Principal — scopes the fiber's sandbox budget. */
	startedBy: number;
	startedAt: number;
	status: 'running' | 'cancelling';
	stepsDone: number;
	/** The current phase label (last tool called), for the progress line. */
	phase: string | null;
	/** The start message's Telegram id — the progress/cancel surface. */
	startMessageId: number | null;
}

/** The DO-SQLite-backed persistence port (the pinned `deep_task` row). */
export interface DeepTaskStore {
	get(): StoredDeepTask | null;
	put(task: StoredDeepTask): void;
	clear(): void;
}

export interface DeepTasksDeps {
	store: DeepTaskStore;
	/** Clock, injected for tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Id factory, injected for tests. Defaults to `crypto.randomUUID()`. */
	newId?: () => string;
	maxSteps?: number;
	wallClockMs?: number;
}

export type StartResult = { task: StoredDeepTask } | { error: string };

/** Whether the loop may run another step; refusals name the budget that tripped. */
export type StepGate = { allowed: true } | { allowed: false; reason: 'cancelled' | 'step-cap' | 'timeout' };

export class DeepTasks {
	private readonly store: DeepTaskStore;
	private readonly now: () => number;
	private readonly newId: () => string;
	readonly maxSteps: number;
	readonly wallClockMs: number;

	constructor(deps: DeepTasksDeps) {
		this.store = deps.store;
		this.now = deps.now ?? Date.now;
		this.newId = deps.newId ?? (() => crypto.randomUUID());
		this.maxSteps = deps.maxSteps ?? DEEP_TASK_MAX_STEPS;
		this.wallClockMs = deps.wallClockMs ?? DEEP_TASK_WALL_CLOCK_MS;
	}

	/** Claim the chat’s single background slot, or return a busy result. */
	start(input: { description: string; prompt: string; startedBy: number }): StartResult {
		const current = this.store.get();
		if (current) {
			return { error: `A deep task is already running ("${current.description}"). Wait for it or cancel it first.` };
		}
		const task: StoredDeepTask = {
			id: this.newId(),
			description: input.description,
			prompt: input.prompt,
			startedBy: input.startedBy,
			startedAt: this.now(),
			status: 'running',
			stepsDone: 0,
			phase: null,
			startMessageId: null,
		};
		this.store.put(task);
		return { task };
	}

	/** Record the start message's id once sent — the progress/cancel surface. */
	attachStartMessage(messageId: number): void {
		const task = this.store.get();
		if (task) this.store.put({ ...task, startMessageId: messageId });
	}

	/**
	 * May the loop run another step? Checked between steps: a cancel request,
	 * the step cap, and the wall clock each end the run with partials delivered
	 * (docs/adr/0040 — a budget trip is never silent discard).
	 */
	beginStep(): StepGate {
		const task = this.store.get();
		if (!task || task.status === 'cancelling') return { allowed: false, reason: 'cancelled' };
		if (task.stepsDone >= this.maxSteps) return { allowed: false, reason: 'step-cap' };
		if (this.now() - task.startedAt > this.wallClockMs) return { allowed: false, reason: 'timeout' };
		return { allowed: true };
	}

	/** A step finished: bump the counter and the phase label. Returns the updated row for the progress edit. */
	recordStep(phase: string | null): StoredDeepTask | null {
		const task = this.store.get();
		if (!task) return null;
		const updated: StoredDeepTask = { ...task, stepsDone: task.stepsDone + 1, phase: phase ?? task.phase };
		this.store.put(updated);
		return updated;
	}

	/**
	 * Request cooperative cancellation. The loop observes it at the next
	 * `beginStep` (and the DO aborts the in-flight model call via the fiber
	 * signal); partials are delivered, never discarded. False when no task runs.
	 */
	requestCancel(): boolean {
		const task = this.store.get();
		if (!task) return false;
		this.store.put({ ...task, status: 'cancelling' });
		return true;
	}

	/** Release the slot (delivery done, or recovery cleanup). */
	finish(): void {
		this.store.clear();
	}

	/** The current slot, or null. */
	snapshot(): StoredDeepTask | null {
		return this.store.get();
	}
}

// ── Surface: callback codec + renderers + delivery composition (pure) ─────────

/** `callback_data` namespace for the deep-task cancel button. */
export const DEEP_TASK_PREFIX = 'dt';

/** Build the cancel `callback_data` (`dt:cancel:<id>`). */
export function deepTaskCancelCallbackData(id: string): string {
	return `${DEEP_TASK_PREFIX}:cancel:${id}`;
}

/** Parse a `dt:cancel:<id>` `callback_data`; `null` when it isn't ours. */
export function parseDeepTaskCallback(data: string | undefined): { id: string } | null {
	if (!data) return null;
	const parts = data.split(':');
	if (parts[0] !== DEEP_TASK_PREFIX || parts[1] !== 'cancel' || parts.length !== 3 || !parts[2]) return null;
	return { id: parts[2] };
}

/** The start/progress message: `🔬 <desc> · step x/20 · <phase>` with the cancel button. */
export function renderDeepTaskProgress(
	task: StoredDeepTask,
	maxSteps: number = DEEP_TASK_MAX_STEPS
): { text: string; keyboard: Telegram.InlineKeyboardButton[][] } {
	const parts = [`🔬 ${task.description}`];
	if (task.stepsDone > 0) parts.push(`step ${task.stepsDone}/${maxSteps}`);
	if (task.phase) parts.push(task.phase);
	return {
		text: parts.join(' · '),
		keyboard: [[{ text: '✖️ Cancel', callback_data: deepTaskCancelCallbackData(task.id) }]],
	};
}

/** The settled line the start message is edited to once the run ends (buttons stripped). */
export function renderDeepTaskSettled(description: string, end: DeepTaskEnd): string {
	const suffix: Record<DeepTaskEnd, string> = {
		completed: '✅ done',
		cancelled: '✖️ cancelled',
		timeout: '⌛ time limit reached',
		error: '⚠️ failed',
		interrupted: '⚠️ interrupted',
	};
	return `🔬 ${description} · ${suffix[end]}`;
}

/** What the delivery queued item posts and persists (docs/adr/0040: no extra inference). */
export interface DeepTaskDelivery {
	/** Message texts, split under Telegram's 4096 cap. */
	messages: string[];
	/** The provenance-wrapped user message appended to the Session. */
	sessionUser: string;
	/** The assistant message appended to the Session (the report itself). */
	sessionAssistant: string;
}

/** Frame a non-completed end so partials are honestly labeled (never silently discarded). */
function endPreamble(end: DeepTaskEnd): string | null {
	switch (end) {
		case 'completed':
			return null;
		case 'cancelled':
			return '✖️ Task cancelled — partial results below.';
		case 'timeout':
			return '⌛ Task hit its 15-minute limit — partial results below.';
		case 'error':
			return '⚠️ Task failed part-way — partial results below.';
		case 'interrupted':
			return '⚠️ Task was interrupted (restart) — partial results below.';
	}
}

/**
 * Compose the delivery for a finished (or aborted) run. The report body is the
 * fiber's own accumulated prose — the final step IS the report; delivery adds
 * only framing. An empty body still delivers an honest line.
 */
export function composeDeepTaskDelivery(input: {
	description: string;
	prompt: string;
	body: string;
	end: DeepTaskEnd;
	error?: string;
}): DeepTaskDelivery {
	const preamble = endPreamble(input.end);
	const errorLine = input.end === 'error' && input.error ? `\n\nError: ${input.error}` : '';
	const body = input.body.trim() || '(the task produced no text before it ended)';
	const text = `${preamble ? `${preamble}\n\n` : ''}${body}${errorLine}`;
	return {
		messages: splitForTelegram(text),
		sessionUser: `[deep task: ${input.description}] ${input.prompt}`,
		sessionAssistant: body,
	};
}

/** Split text under Telegram's `sendMessage` cap, preferring paragraph then line boundaries. */
export function splitForTelegram(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const slice = rest.slice(0, limit);
		const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
		const at = cut > limit / 2 ? cut : limit;
		chunks.push(rest.slice(0, at).trimEnd());
		rest = rest.slice(at).trimStart();
	}
	if (rest) chunks.push(rest);
	return chunks;
}

/**
 * **Deep task** cancel taps (docs/adr/0040): `dt:cancel:<id>`. Gated on
 * `schedule_turns` — the tool's own trust tier. Cancellation is cooperative:
 * partial results follow via the fiber's normal delivery, which also settles
 * the start message, so no edit happens here.
 */
export const deepTaskCallbackFamily: CallbackFamily<{ id: string }> = {
	parse: parseDeepTaskCallback,
	capability: 'schedule_turns',
	act: async (parsed, ctx) => {
		const agent = await ctx.agent();
		const cancelled = await agent.cancelDeepTask(parsed.id);
		return {
			kind: 'toast',
			text: cancelled ? '✖️ Cancelling — partial results will follow.' : 'That task is already finished.',
		};
	},
};
