import { describe, it, expect } from 'vitest';
import {
	UsageLedger,
	renderUsageReport,
	usageDay,
	type UsageLedgerStore,
	type UsageRow,
} from '../features/agent/usage-ledger';

/** In-memory `UsageLedgerStore` with real UPSERT-accumulate semantics. */
function fakeStore(): UsageLedgerStore & { rows: Map<string, UsageRow> } {
	const rows = new Map<string, UsageRow>();
	return {
		rows,
		accumulate: (row) => {
			const key = `${row.day}|${row.userId}|${row.kind}|${row.model}`;
			const existing = rows.get(key);
			rows.set(
				key,
				existing
					? {
							...existing,
							inputTokens: existing.inputTokens + row.inputTokens,
							outputTokens: existing.outputTokens + row.outputTokens,
							cacheReadTokens: existing.cacheReadTokens + row.cacheReadTokens,
							reasoningTokens: existing.reasoningTokens + row.reasoningTokens,
						}
					: { ...row }
			);
		},
		listSince: (sinceDay) => [...rows.values()].filter((row) => row.day >= sinceDay),
	};
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tests the **Usage ledger** (PRD #100): same-bucket accumulation, zero
 * defaults for absent token fields, day-keyed attribution, the today/7-day
 * report windows, and the `/usage` token renderer. Pure module + in-memory
 * store + fixed clock — no DO, no model.
 */
describe('UsageLedger', () => {
	it('accumulates records in the same (day, user, kind, model) bucket; different keys stay separate', () => {
		const store = fakeStore();
		const nowMs = Date.UTC(2026, 6, 10, 12);
		const ledger = new UsageLedger({ store, now: () => nowMs });
		ledger.record({ userId: 42, kind: 'chat', model: 'glm-5', usage: { inputTokens: 100, outputTokens: 50 } });
		ledger.record({ userId: 42, kind: 'chat', model: 'glm-5', usage: { inputTokens: 30, outputTokens: 20 } });
		ledger.record({ userId: 42, kind: 'compaction', model: 'glm-5', usage: { inputTokens: 7, outputTokens: 3 } });
		ledger.record({ userId: 99, kind: 'chat', model: 'glm-5', usage: { inputTokens: 1, outputTokens: 1 } });
		expect(store.rows.size).toBe(3);
		const chat = store.rows.get(`${usageDay(nowMs)}|42|chat|glm-5`);
		expect(chat?.inputTokens).toBe(130);
		expect(chat?.outputTokens).toBe(70);
	});

	it('absent token fields default to zero; nested detail fields are read', () => {
		const store = fakeStore();
		const ledger = new UsageLedger({ store, now: () => Date.UTC(2026, 6, 10) });
		ledger.record({
			userId: 42,
			kind: 'chat',
			model: 'glm-5',
			usage: {
				inputTokens: 100,
				outputTokens: undefined,
				inputTokenDetails: { cacheReadTokens: 80 },
				outputTokenDetails: { reasoningTokens: 12 },
			},
		});
		const row = [...store.rows.values()][0];
		expect(row.outputTokens).toBe(0);
		expect(row.cacheReadTokens).toBe(80);
		expect(row.reasoningTokens).toBe(12);
	});

	it('today vs the trailing 7 days: older rows fall out of the week', () => {
		const store = fakeStore();
		let nowMs = Date.UTC(2026, 6, 1, 12);
		const ledger = new UsageLedger({ store, now: () => nowMs });
		ledger.record({ userId: 42, kind: 'chat', model: 'glm-5', usage: { inputTokens: 10, outputTokens: 1 } });
		nowMs += 8 * DAY_MS; // now 2026-07-09: the first record is out of the window
		ledger.record({ userId: 42, kind: 'chat', model: 'glm-5', usage: { inputTokens: 20, outputTokens: 2 } });
		nowMs += 1 * DAY_MS; // now 2026-07-10: yesterday's record is in the week, not today
		ledger.record({ userId: 42, kind: 'chat', model: 'glm-5', usage: { inputTokens: 40, outputTokens: 4 } });

		const report = ledger.report();
		expect(report.today.length).toBe(1);
		expect(report.today[0].inputTokens).toBe(40);
		expect(report.week.length).toBe(1);
		expect(report.week[0].inputTokens).toBe(60);
	});

	it('merges users in a kind line; kinds stay separate lines, sorted by volume', () => {
		const store = fakeStore();
		const ledger = new UsageLedger({ store, now: () => Date.UTC(2026, 6, 10) });
		ledger.record({ userId: 42, kind: 'chat', model: 'glm-5', usage: { inputTokens: 5, outputTokens: 0 } });
		ledger.record({ userId: 99, kind: 'chat', model: 'glm-5', usage: { inputTokens: 5, outputTokens: 0 } });
		ledger.record({ userId: 42, kind: 'deep_task', model: 'glm-5', usage: { inputTokens: 100, outputTokens: 0 } });
		const report = ledger.report();
		expect(report.today.length).toBe(2);
		expect(report.today[0].kind).toBe('deep_task');
		expect(report.today[1].inputTokens).toBe(10);
	});
});

describe('renderUsageReport', () => {
	it('renders an empty ledger honestly', () => {
		expect(renderUsageReport({ today: [], week: [] }).includes('none recorded')).toBe(true);
	});

	it('renders the today header with compact numbers and cache reads; omits zero reasoning', () => {
		const line = {
			kind: 'chat' as const,
			model: 'glm-5',
			inputTokens: 12_400,
			outputTokens: 842,
			cacheReadTokens: 1_200_000,
			reasoningTokens: 0,
		};
		const text = renderUsageReport({ today: [line], week: [line] });
		expect(text.includes('🪙 Tokens today:')).toBe(true);
		expect(text.includes('chat · glm-5: 12.4k in / 842 out')).toBe(true);
		expect(text.includes('1.2M cached')).toBe(true);
		expect(!text.includes('reasoning')).toBe(true);
	});

	it('an empty today section says none', () => {
		const line = {
			kind: 'chat' as const,
			model: 'glm-5',
			inputTokens: 12_400,
			outputTokens: 842,
			cacheReadTokens: 0,
			reasoningTokens: 0,
		};
		expect(renderUsageReport({ today: [], week: [line] }).includes('  none')).toBe(true);
	});
});