// bun:sqlite as the store's SQL connection.
import { Database } from 'bun:sqlite';
import type { SQL, Value } from '../chat/sql';

export function openBun(path: string): SQL {
	const db = new Database(path, { create: true, strict: true });
	const cache = new Map<string, ReturnType<Database['query']>>();
	const query = (sql: string) => {
		let q = cache.get(sql);
		if (!q) { q = db.query(sql); cache.set(sql, q); }
		return q;
	};
	return {
		exec: sql => { db.exec(sql); },
		run: (sql, ...params: Value[]) => ({ changes: query(sql).run(...(params as never[])).changes }),
		get: <T>(sql: string, ...params: Value[]) => (query(sql).get(...(params as never[])) ?? undefined) as T | undefined,
		all: <T>(sql: string, ...params: Value[]) => query(sql).all(...(params as never[])) as T[],
		transaction: fn => db.transaction(fn)(),
		close: () => { for (const q of cache.values()) q.finalize(); cache.clear(); db.close(); },
	};
}
