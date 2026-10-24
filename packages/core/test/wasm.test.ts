import { expect, test } from 'bun:test';
import init from '@sqlite.org/sqlite-wasm';
import { ProviderRegistry, Server, Store, textOf } from '../src';
import { openWasm } from '../src/sqlite/wasm';

// The browser runs the same store and API on sqlite-wasm.
const sqlite3 = await init();
const memory = () => openWasm(new sqlite3.oo1.DB(':memory:'));

test('a transaction inside another rolls back alone', () => {
	const db = memory();
	db.exec('CREATE TABLE t(v)');
	db.transaction(() => {
		db.run('INSERT INTO t VALUES(?)', 1);
		expect(() => db.transaction(() => { db.run('INSERT INTO t VALUES(?)', true); throw new Error('inner'); })).toThrow('inner');
	});
	expect(db.all<{ v: number }>('SELECT v FROM t')).toEqual([{ v: 1 }]);
	expect(db.run('UPDATE t SET v=?', 2).changes).toBe(1);
	expect(db.get('SELECT v FROM t WHERE v=?', 3)).toBeUndefined();
});

test('the API answers a turn on sqlite-wasm', async () => {
	const store = new Store(memory()).open();
	const token = 't'.repeat(64);
	const server = new Server({ store, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' });
	const call = (method: string, path: string, body?: object) =>
		server.fetch(new Request('http://localhost' + path, { method, body: body && JSON.stringify(body), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }));
	const c = await (await call('POST', '/api/conversations', {})).json() as { id: string };
	const stream = await (await call('POST', '/api/chat', { id: c.id, text: 'hello', requestId: 'r1' })).text();
	expect(stream).toContain('[DONE]');
	expect(textOf(store.history(c.id)[1])).toContain('Received: hello');
	await server.close();
	store.close();
});

test('a failed commit rolls back and the next transaction still works', () => {
	const db = memory();
	db.exec('PRAGMA foreign_keys=ON; CREATE TABLE p(id PRIMARY KEY); CREATE TABLE c(p REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
	expect(() => db.transaction(() => { db.run('INSERT INTO c VALUES(?)', 1); })).toThrow('FOREIGN KEY');
	expect(db.all('SELECT * FROM c')).toEqual([]);
	db.transaction(() => db.transaction(() => { db.run('INSERT INTO p VALUES(?)', 1); db.run('INSERT INTO c VALUES(?)', 1); }));
	expect(db.all('SELECT * FROM c')).toEqual([{ p: 1 }]);
});
