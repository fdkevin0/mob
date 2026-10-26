import { expect, test } from 'bun:test';
import { openBun } from '../src/sqlite/bun';
import { schema } from '../src/chat/schema';
import { Store } from '../src/chat/store';

test('a database the Go service left at schema 10 is upgraded', () => {
	const db = openBun(':memory:');
	// Schema 10: tasks without the columns readers and results added.
	db.exec(schema.replace(", read_only INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT ''", '')
		.replace(", stats TEXT NOT NULL DEFAULT ''", '').replace(", first_token_ms INTEGER NOT NULL DEFAULT 0", '').replace(",\n flow TEXT NOT NULL DEFAULT ''", ''));
	db.exec('PRAGMA user_version=10');
	const store = new Store(db, 'test').open();
	const t = store.createTask({ project: 'p', agent: 'codex', title: 'x', worktree: '/w', branch: 'b', status: 'review', readOnly: true });
	store.setTaskResult(t.id, 'passed', 'ok');
	expect(store.task(t.id)).toMatchObject({ readOnly: true, outcome: 'passed', result: 'ok' });
	expect(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(14);
	// Schema 13: replies keep their timing, and the ledger each request's first-token time.
	const c = store.create();
	const m = store.begin(c.id, 'r'.repeat(20), 'hi', 'demo/echo');
	m.stats = { startedAt: 1, finishedAt: 5, firstTokenMs: 2 };
	store.save(m, 'complete', '');
	store.recordUsage(c.id, m.id, 'demo/echo', { inputTokens: 1, outputTokens: 1 }, 4, '', 2);
	expect(store.history(c.id)[1].stats).toEqual({ startedAt: 1, finishedAt: 5, firstTokenMs: 2 });
	expect(store.exportConversation(c.id).usage[0].firstTokenMs).toBe(2);
	// Schema 14: tasks keep where they are in their blueprint.
	store.setTaskFlow(t.id, { blueprint: 'quick', stage: 'ready', round: 1, tries: 0, checks: [{ command: 'true', passed: true, exitCode: 0, seconds: 0 }] });
	expect(store.task(t.id)!.flow).toMatchObject({ blueprint: 'quick', stage: 'ready', checks: [{ command: 'true', passed: true }] });
	store.close();
});
