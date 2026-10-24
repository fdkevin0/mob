import { expect, test } from 'bun:test';
import { at, next, Schedules } from '../src/app/schedule';

const sh = 'Asia/Shanghai', ny = 'America/New_York';
const day = 86400_000;

test('next keeps the time of day in its zone', () => {
	const friday = at(2026, 10, 23, 9, 0, sh);
	expect(friday).toBe(Date.parse('2026-10-23T09:00:00+08:00'));
	expect(next(friday, 'daily', sh, '09:00', friday)).toBe(friday + day);
	expect(next(friday, 'weekdays', sh, '09:00', friday)).toBe(at(2026, 10, 26, 9, 0, sh));
	expect(next(friday, 'weekly', sh, '09:00', friday)).toBe(friday + 7 * day);
	expect(next(friday, 'hourly', sh, '09:00', friday + 90 * 60_000)).toBe(friday + 2 * 3600_000);
	// Missed runs collapse into the next one.
	expect(next(friday, 'daily', sh, '09:00', friday + 3 * day + 3600_000)).toBe(friday + 4 * day);
	// Across the end of daylight saving.
	expect(next(at(2026, 10, 31, 9, 0, ny), 'daily', ny, '09:00', at(2026, 10, 31, 9, 0, ny))).toBe(Date.parse('2026-11-01T09:00:00-05:00'));
	// A day that skips 02:30 moves that run only.
	expect(at(2026, 3, 8, 2, 30, ny)).toBe(Date.parse('2026-03-08T03:30:00-04:00'));
	expect(next(at(2026, 3, 7, 2, 30, ny), 'daily', ny, '02:30', at(2026, 3, 8, 12, 0, ny))).toBe(Date.parse('2026-03-09T02:30:00-04:00'));
	// A repeated hour runs at its first instance.
	expect(at(2026, 11, 1, 1, 30, ny)).toBe(Date.parse('2026-11-01T01:30:00-04:00'));
});

test('ask checks its input before asking', async () => {
	const now = Date.parse('2026-10-21T08:00:00Z');
	const s = new Schedules({} as never, {} as never, () => now);
	const asked: unknown[] = [];
	const request = async (r: unknown): Promise<never> => { asked.push(r); throw new Error('asked'); };
	const ask = (input: Record<string, unknown>) => s.ask(input, request);
	expect(() => ask({ prompt: ' ', at: '2026-10-22T09:00:00Z' })).toThrow('prompt must be');
	expect(() => ask({ prompt: 'x', at: '2026-10-22 09:00' })).toThrow('RFC 3339');
	expect(() => ask({ prompt: 'x', at: '2026-10-22T09:00:00Z', repeat: 'yearly' })).toThrow('repeat must be');
	expect(() => ask({ prompt: 'x', at: '2026-10-22T09:00:00Z', timezone: 'Mars/Base' })).toThrow('unknown time zone');
	expect(() => ask({ prompt: 'x', at: '2026-10-20T09:00:00Z' })).toThrow('has passed');
	await expect(ask({ prompt: ' sum up ', at: '2026-10-22T09:00:00.5+08:00', repeat: 'daily', timezone: sh })).rejects.toThrow('asked');
	expect(asked).toEqual([{ prompt: 'sum up', at: '2026-10-22T09:00:00+08:00', repeat: 'daily', timezone: sh }]);
});

test('due schedules run, repeat and report their own turn', async () => {
	const { mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { ConversationService, DemoModel, Store } = await import('../src');
	const { openBun } = await import('../src/sqlite/bun');
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-sched-')), 'chat.sqlite'))).open();
	const service = new ConversationService(store, { default: () => 'demo/echo', resolve: () => new DemoModel(), setDefault: () => new DemoModel().ref, list: async () => [] });
	let now = Date.parse('2026-10-21T08:00:00Z');
	const s = new Schedules(store, service, () => now);
	const c = store.create();
	const notices: string[] = [];
	service.notices(n => { notices.push(n.text); });
	const once = s.add(c.id, { prompt: 'say once', at: '2026-10-21T08:30:00Z' });
	s.add(c.id, { prompt: 'say daily', at: '2026-10-21T07:00:00Z', repeat: 'daily', timezone: 'UTC' });
	expect(store.schedules(0).map(x => x.next)).toEqual([Date.parse('2026-10-21T08:30:00Z'), Date.parse('2026-10-22T07:00:00Z')]);
	now = Date.parse('2026-10-21T08:31:00Z');
	await s.runDue();
	expect(store.schedules(0).map(x => x.id)).not.toContain(once.schedule);
	const deadline = Date.now() + 5000;
	while (!notices.length && Date.now() < deadline) await Bun.sleep(20);
	expect(notices[0]).toStartWith('**Scheduled:** say once\n\n');
	expect(notices[0]).not.toContain('did not finish');
	store.close();
});
