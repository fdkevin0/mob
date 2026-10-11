/** UTC-day sandbox accounting. The injected store scopes buckets to one user in one chat; code and shell share the budget. */

/** Default daily budget (seconds) when `SANDBOX_DAILY_LIMIT_SECONDS` is unset. */
export const DEFAULT_SANDBOX_DAILY_LIMIT_SECONDS = 120;

/**
 * Resolve the env-configured daily budget to **milliseconds**. Accepts the raw
 * `SANDBOX_DAILY_LIMIT_SECONDS` var (a number from wrangler `[vars]`); falls back
 * to {@link DEFAULT_SANDBOX_DAILY_LIMIT_SECONDS} when unset or invalid. A value of
 * `0` means **unlimited** (gating disabled) — the escape hatch.
 */
export function sandboxDailyLimitMs(seconds: number | string | undefined): number {
	const s = Number(seconds);
	return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_SANDBOX_DAILY_LIMIT_SECONDS) * 1000;
}

/** UTC calendar-day key (`YYYY-MM-DD`) used to bucket daily usage. */
function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** A snapshot of one user's sandbox budget today, for the `/usage` command. */
export interface SandboxUsageReport {
	/** Execution ms spent today. */
	usedMs: number;
	/** Budget ms left today (>= 0); meaningless when `limitMs <= 0`. */
	remainingMs: number;
	/** Configured daily budget ms; `<= 0` means unlimited. */
	limitMs: number;
}

/** Whole-seconds-with-one-decimal rendering of a ms duration (e.g. 18400 → "18.4"). */
function seconds(ms: number): string {
	return (ms / 1000).toFixed(1);
}

/**
 * Render a {@link SandboxUsageReport} as the one-line `/usage` reply. When no daily
 * limit is set (`limitMs <= 0`), "used / remaining" is meaningless, so it shows only
 * the time spent. Pure — unit-tested without a DO.
 */
export function formatSandboxUsageReport(report: SandboxUsageReport): string {
	if (report.limitMs <= 0) {
		return `💻 Sandbox usage today: ${seconds(report.usedMs)}s used · no daily limit set`;
	}
	return (
		`💻 Sandbox usage today: ${seconds(report.usedMs)}s / ${seconds(report.limitMs)}s used · ` +
		`${seconds(report.remainingMs)}s left (resets 00:00 UTC)`
	);
}

/** Accumulated-ms store, keyed by UTC day. Backed by DO SQLite in production. */
export interface SandboxUsageStore {
	/** Accumulated execution ms for `day`, or 0 if none recorded. */
	get(day: string): number;
	/** Persist `usedMs` as the new accumulated total for `day`. */
	set(day: string, usedMs: number): void;
}

export interface SandboxUsageDeps {
	store: SandboxUsageStore;
	/** Daily budget in milliseconds; `<= 0` disables gating (unlimited). */
	limitMs: number;
	/** Clock; defaults to `() => new Date()`. */
	now?: () => Date;
}

/**
 * The minimal gate the `run_code` and `run_shell` tools consume (docs/adr/0019).
 * `SandboxUsage` satisfies it structurally; keeping the tools to this interface lets
 * them be tested with a hand-rolled fake gate.
 */
export interface SandboxUsageGate {
	/** Whether another execution is permitted under today's budget. */
	allows(): boolean;
	/** Charge `elapsedMs` of execution against today's budget. */
	record(elapsedMs: number): void;
}

export class SandboxUsage implements SandboxUsageGate {
	private readonly store: SandboxUsageStore;
	private readonly limitMs: number;
	private readonly now: () => Date;

	constructor(deps: SandboxUsageDeps) {
		this.store = deps.store;
		this.limitMs = deps.limitMs;
		this.now = deps.now ?? (() => new Date());
	}

	private today(): string {
		return utcDayKey(this.now());
	}

	/** Execution ms already spent today. */
	usedMs(): number {
		return this.store.get(this.today());
	}

	remainingMs(): number {
		return Math.max(0, this.limitMs - this.usedMs());
	}

	allows(): boolean {
		// A non-positive limit means the cap is disabled (unlimited).
		return this.limitMs <= 0 || this.remainingMs() > 0;
	}

	record(elapsedMs: number): void {
		// Ignore non-positive deltas, and skip the write entirely when unlimited so
		// the `sandbox_usage` table stays empty in the disabled configuration.
		if (this.limitMs <= 0 || elapsedMs <= 0) return;
		const day = this.today();
		this.store.set(day, this.store.get(day) + elapsedMs);
	}
}
