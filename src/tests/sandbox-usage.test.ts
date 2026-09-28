import { describe, it, expect } from 'vitest';
import {
	SandboxUsage,
	sandboxDailyLimitMs,
	formatSandboxUsageReport,
	DEFAULT_SANDBOX_DAILY_LIMIT_SECONDS,
	type SandboxUsageStore,
} from '../features/agent/sandbox-usage';

/** In-memory `SandboxUsageStore` — the DO SQLite stand-in for unit tests. */
function fakeStore(): SandboxUsageStore & { rows: Map<string, number> } {
	const rows = new Map<string, number>();
	return {
		rows,
		get: (day) => rows.get(day) ?? 0,
		set: (day, usedMs) => void rows.set(day, usedMs),
	};
}

/**
 * Tests the **Sandbox usage budget** (docs/adr/0019, issue #77): the per-chat daily
 * run-time cap on `run_code`. Pure module + in-memory fake + fixed clock — no DO.
 */
describe('formatSandboxUsageReport', () => {
	it('renders a limited report', () => {
		const limited = formatSandboxUsageReport({ usedMs: 18_400, remainingMs: 101_600, limitMs: 120_000 });
		expect(limited).toBe('💻 Sandbox usage today: 18.4s / 120.0s used · 101.6s left (resets 00:00 UTC)');
	});

	it('renders an unlimited report when no limit is set', () => {
		const unlimited = formatSandboxUsageReport({ usedMs: 18_400, remainingMs: 0, limitMs: 0 });
		expect(unlimited).toBe('💻 Sandbox usage today: 18.4s used · no daily limit set');
	});

	it('renders a fresh budget', () => {
		const fresh = formatSandboxUsageReport({ usedMs: 0, remainingMs: 120_000, limitMs: 120_000 });
		expect(/^💻 Sandbox usage today: 0\.0s \/ 120\.0s used · 120\.0s left/.test(fresh)).toBe(true);
	});
});

describe('sandboxDailyLimitMs', () => {
	it('resolves seconds → ms', () => {
		expect(sandboxDailyLimitMs(120)).toBe(120_000);
	});

	it('parses a numeric string', () => {
		expect(sandboxDailyLimitMs('90')).toBe(90_000);
	});

	it('keeps zero (unlimited)', () => {
		expect(sandboxDailyLimitMs(0)).toBe(0);
	});

	it('falls back to the default for undefined, garbage, or negative', () => {
		const expected = DEFAULT_SANDBOX_DAILY_LIMIT_SECONDS * 1000;
		expect(sandboxDailyLimitMs(undefined)).toBe(expected);
		expect(sandboxDailyLimitMs('nonsense')).toBe(expected);
		expect(sandboxDailyLimitMs(-5)).toBe(expected);
	});
});

describe('SandboxUsage', () => {
	it('accumulates and blocks at the limit', () => {
		const store = fakeStore();
		const usage = new SandboxUsage({ store, limitMs: 1000, now: () => new Date('2026-06-21T10:00:00.000Z') });

		expect(usage.allows()).toBe(true);
		expect(usage.remainingMs()).toBe(1000);

		usage.record(600);
		expect(usage.usedMs()).toBe(600);
		expect(usage.remainingMs()).toBe(400);
		expect(usage.allows()).toBe(true);

		usage.record(500); // total 1100 > 1000
		expect(usage.remainingMs()).toBe(0);
		expect(usage.allows()).toBe(false);
	});

	it('rolls the budget over at the new UTC day (and leaves yesterday untouched)', () => {
		const store = fakeStore();
		let clock = new Date('2026-06-21T23:59:00.000Z');
		const usage = new SandboxUsage({ store, limitMs: 1000, now: () => clock });

		usage.record(1000);
		expect(usage.allows()).toBe(false);

		clock = new Date('2026-06-22T00:01:00.000Z');
		expect(usage.allows()).toBe(true);
		expect(usage.remainingMs()).toBe(1000);
		// Yesterday's bucket is untouched, today's is separate.
		expect(store.rows.get('2026-06-21')).toBe(1000);
	});

	it('a zero limit means unlimited and writes nothing', () => {
		const store = fakeStore();
		const usage = new SandboxUsage({ store, limitMs: 0, now: () => new Date('2026-06-21T10:00:00.000Z') });

		expect(usage.allows()).toBe(true);
		usage.record(999_999);
		expect(usage.allows()).toBe(true);
		expect(store.rows.size).toBe(0);
	});

	it('ignores non-positive deltas (no row written)', () => {
		const store = fakeStore();
		const usage = new SandboxUsage({ store, limitMs: 1000, now: () => new Date('2026-06-21T10:00:00.000Z') });

		usage.record(0);
		usage.record(-50);
		expect(usage.usedMs()).toBe(0);
		expect(store.rows.size).toBe(0);
	});
});