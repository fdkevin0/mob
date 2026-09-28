import type { Agent } from 'agents';
import { Cron } from 'croner';

/**
 * The **Scheduled turn** core (docs/adr/0028): a stored prompt the Conversation
 * Agent runs against itself at a future time, one-off or recurring. This module
 * is the pure heart — validation, the local-time DST-correct recurrence math
 * (croner), reschedule-before-run, and the dumb guardrails — over injected
 * store/scheduler ports. The core uses injected store/scheduler ports; the cancellation helper
 * reads the SDK schedule records directly.
 */

/** Hard ceiling on active scheduled turns per chat (docs/adr/0028). */
export const MAX_ACTIVE_SCHEDULED_TURNS = 10;

/** Minimum gap between recurring occurrences (docs/adr/0028). */
export const MIN_RECURRENCE_MS = 15 * 60 * 1000;

/** How a scheduled turn recurs: a single future instant, or a cron in a timezone. */
export type ScheduledWhen =
	| { kind: 'once'; at: number }
	| { kind: 'recurring'; cron: string; timezone: string };

/** A stored scheduled turn. `failed` marks a one-off whose firing errored (kept listed for re-run). */
export interface StoredScheduledTurn {
	id: string;
	description: string;
	prompt: string;
	when: ScheduledWhen;
	status: 'active' | 'failed';
	lastError: string | null;
	createdAt: number;
}

/** A listed scheduled turn: the stored row plus its computed next fire (null when none). */
export interface ScheduledTurnView extends StoredScheduledTurn {
	next: Date | null;
}

/** The DO-SQLite-backed persistence port (the `scheduled_turns` table). */
export interface ScheduledTurnStore {
	upsert(task: StoredScheduledTurn): void;
	getById(id: string): StoredScheduledTurn | null;
	list(): StoredScheduledTurn[];
	deleteById(id: string): void;
}

/** Registers one pending occurrence per task, cancelling older occurrences first. */
export interface OccurrenceScheduler {
	register(taskId: string, at: Date): Promise<void>;
	cancelPending(taskId: string): Promise<void>;
}

/** Cancel only this task's occurrences, including records created before the mapping table was retired. */
export async function cancelPendingTurnAlarms(
	agent: Pick<Agent, 'listSchedules' | 'cancelSchedule'>,
	taskId: string,
): Promise<void> {
	for (const schedule of await agent.listSchedules()) {
		const payload = schedule.payload;
		if (schedule.callback === 'onScheduledTurnAlarm' && payload && typeof payload === 'object' &&
			'taskId' in payload && payload.taskId === taskId) {
			await agent.cancelSchedule(schedule.id);
		}
	}
}

/** The `schedule_turn` tool's `when` input: exactly one of `at` / `recurrence`. */
export interface WhenInput {
	at?: string;
	recurrence?: string;
	timezone?: string;
}

export interface CreateScheduledTurnInput {
	prompt: string;
	description: string;
	when: WhenInput;
}

export interface ScheduledTurnsDeps {
	store: ScheduledTurnStore;
	scheduler: OccurrenceScheduler;
	/** Clock, injected for tests. Defaults to `new Date()`. */
	now?: () => Date;
	/** IANA timezone a recurrence defaults to (`BOT_TIMEZONE`). Defaults to UTC. */
	defaultTimezone?: string;
	/** Id factory, injected for tests. Defaults to `crypto.randomUUID()`. */
	newId?: () => string;
}

/** A create outcome: the stored task and its first fire, or a soft error for the model. */
export type CreateResult = { task: StoredScheduledTurn; next: Date } | { error: string };

export class ScheduledTurns {
	private readonly store: ScheduledTurnStore;
	private readonly scheduler: OccurrenceScheduler;
	private readonly now: () => Date;
	private readonly defaultTimezone: string;
	private readonly newId: () => string;

	constructor(deps: ScheduledTurnsDeps) {
		this.store = deps.store;
		this.scheduler = deps.scheduler;
		this.now = deps.now ?? (() => new Date());
		this.defaultTimezone = deps.defaultTimezone ?? 'UTC';
		this.newId = deps.newId ?? (() => crypto.randomUUID());
	}

	/**
	 * Validate and store a new scheduled turn and register its first occurrence.
	 * Guardrail violations (cap, minimum recurrence, past/invalid instants, bad
	 * cron/timezone) are soft `{ error }`s — the Weather-tool pattern — so the
	 * model can relay them instead of crashing the turn.
	 */
	async create(input: CreateScheduledTurnInput): Promise<CreateResult> {
		const active = this.store.list().filter((t) => t.status === 'active').length;
		if (active >= MAX_ACTIVE_SCHEDULED_TURNS) {
			return {
				error: `Limit reached: ${MAX_ACTIVE_SCHEDULED_TURNS} active scheduled turns. Ask the user which to cancel first.`,
			};
		}

		const resolved = this.resolveWhen(input.when);
		if ('error' in resolved) return resolved;

		const task: StoredScheduledTurn = {
			id: this.newId(),
			description: input.description,
			prompt: input.prompt,
			when: resolved.when,
			status: 'active',
			lastError: null,
			createdAt: this.now().getTime(),
		};
		this.store.upsert(task);
		await this.scheduler.register(task.id, resolved.next);
		return { task, next: resolved.next };
	}

	/** All stored turns with their computed next fire (active recurring/once; `null` for failed). */
	list(): ScheduledTurnView[] {
		const from = this.now();
		return this.store.list().map((task) => ({ ...task, next: this.nextFor(task, from) }));
	}

	/**
	 * Cancel a task: drop any pending occurrence, then the row. False when the id
	 * is unknown. Order matters — `cancelPending` must run *before* `deleteById`:
	 * a failed SDK cancellation must leave the task available for another attempt.
	 */
	async cancel(id: string): Promise<boolean> {
		if (!this.store.getById(id)) return false;
		await this.scheduler.cancelPending(id);
		this.store.deleteById(id);
		return true;
	}

	/**
	 * An occurrence fired: **reschedule before run** (docs/adr/0028). For a
	 * recurring task the next occurrence is registered *here*, before the caller
	 * runs the agentic turn, so a crashing turn cannot kill the chain. Returns the
	 * task to run (plus the registered next), or `null` for an unknown/cancelled id.
	 */
	async beginFire(id: string, firedAt: Date): Promise<{ task: StoredScheduledTurn; next: Date | null } | null> {
		const task = this.store.getById(id);
		if (!task) return null;

		let next: Date | null = null;
		if (task.when.kind === 'recurring') {
			next = nextOccurrence(task.when.cron, task.when.timezone, firedAt);
			if (next) await this.scheduler.register(task.id, next);
		}
		return { task, next };
	}

	/**
	 * The fired turn finished. Success: a one-off is done (row dropped); a
	 * recurring clears any stale error. Failure: a one-off is kept, marked
	 * `failed`, for conversational re-run; a recurring stays active (its chain
	 * already advanced in `beginFire`) with the error visible in the list.
	 */
	completeFire(id: string, outcome: { ok: true } | { ok: false; error: string }): void {
		const task = this.store.getById(id);
		if (!task) return;

		if (outcome.ok) {
			if (task.when.kind === 'once') this.store.deleteById(id);
			else if (task.lastError) this.store.upsert({ ...task, lastError: null });
			return;
		}

		this.store.upsert({
			...task,
			status: task.when.kind === 'once' ? 'failed' : task.status,
			lastError: outcome.error,
		});
	}

	/** The task's next fire from `from`: the stored instant, the cron's next run, or `null`. */
	private nextFor(task: StoredScheduledTurn, from: Date): Date | null {
		if (task.status === 'failed') return null;
		if (task.when.kind === 'once') return task.when.at > from.getTime() ? new Date(task.when.at) : null;
		return nextOccurrence(task.when.cron, task.when.timezone, from);
	}

	/** Normalize the tool's `when` input to a `ScheduledWhen` + first occurrence, or a soft error. */
	private resolveWhen(when: WhenInput): { when: ScheduledWhen; next: Date } | { error: string } {
		const hasAt = typeof when.at === 'string';
		const hasRecurrence = typeof when.recurrence === 'string';
		if (hasAt === hasRecurrence) {
			return { error: 'Pass exactly one of `at` (a future ISO datetime) or `recurrence` (a cron expression).' };
		}

		if (hasAt) {
			const at = new Date(when.at as string);
			if (Number.isNaN(at.getTime())) return { error: `Unparseable datetime: ${when.at}` };
			if (at.getTime() <= this.now().getTime()) return { error: `That instant is in the past: ${at.toISOString()}` };
			return { when: { kind: 'once', at: at.getTime() }, next: at };
		}

		const cron = (when.recurrence as string).trim();
		const timezone = when.timezone?.trim() || this.defaultTimezone;
		let occurrences: Date[];
		try {
			occurrences = nextOccurrences(cron, timezone, this.now(), 4);
		} catch (error) {
			return { error: `Invalid recurrence or timezone: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (occurrences.length === 0) return { error: `That recurrence never fires: ${cron}` };

		for (let i = 1; i < occurrences.length; i++) {
			if (occurrences[i].getTime() - occurrences[i - 1].getTime() < MIN_RECURRENCE_MS) {
				return { error: 'Recurring turns must be at least 15 minutes apart.' };
			}
		}
		return { when: { kind: 'recurring', cron, timezone }, next: occurrences[0] };
	}
}

/** The next local-time occurrence of `cron` in `timezone` strictly after `from`, or `null`. */
export function nextOccurrence(cron: string, timezone: string, from: Date): Date | null {
	return new Cron(cron, { timezone }).nextRun(from);
}

/** The next `count` occurrences after `from` (for the minimum-gap guardrail). Throws on a bad cron/timezone. */
function nextOccurrences(cron: string, timezone: string, from: Date, count: number): Date[] {
	return new Cron(cron, { timezone }).nextRuns(count, from);
}
