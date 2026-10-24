import { expect, test } from 'bun:test';
import { openBun } from '../src/sqlite/bun';
import { schema } from '../src/chat/schema';
import { Store } from '../src/chat/store';

test('a database the Go service left at schema 10 is upgraded', () => {
	const db = openBun(':memory:');
	// Schema 10: tasks without the columns readers and results added.
	db.exec(schema.replace(", read_only INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT ''", ''));
	db.exec('PRAGMA user_version=10');
	const store = new Store(db, 'test').open();
	const t = store.createTask({ project: 'p', agent: 'codex', title: 'x', worktree: '/w', branch: 'b', status: 'review', readOnly: true });
	store.setTaskResult(t.id, 'passed', 'ok');
	expect(store.task(t.id)).toMatchObject({ readOnly: true, outcome: 'passed', result: 'ok' });
	expect(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(12);
	store.close();
});
