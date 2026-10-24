// sqlite-wasm (the official @sqlite.org/sqlite-wasm build) as the store's SQL
// connection in a browser. It takes an opened oo1 database, so the core does
// not depend on the package; the browser host opens it, on OPFS when it can.
import type { SQL, Value } from '../chat/sql';

type Bind = (string | number | bigint | null)[];

/** OO1 is the part of sqlite-wasm's oo1.DB the store uses. */
export interface OO1 {
	exec(sql: string): unknown;
	exec(sql: string, opts: { bind: Bind }): unknown;
	exec(sql: string, opts: { bind: Bind; rowMode: 'object'; returnValue: 'resultRows' }): unknown;
	changes(): number;
	close(): void;
}

// sqlite-wasm binds no booleans; bun:sqlite stores them as 0 and 1.
const bind = (params: Value[]): Bind => params.map(v => typeof v === 'boolean' ? (v ? 1 : 0) : v);

export function openWasm(db: OO1): SQL {
	const all = <T>(sql: string, params: Value[]) => db.exec(sql, { bind: bind(params), rowMode: 'object', returnValue: 'resultRows' }) as T[];
	let depth = 0;
	// rollback undoes a failed transaction; an error of its own must not hide the one that caused it.
	const rollback = (level: number, name: string) => {
		try { db.exec(level ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK'); } catch { /* SQLite may have rolled back already */ }
	};
	return {
		exec: sql => { db.exec(sql); },
		run: (sql, ...params) => { db.exec(sql, { bind: bind(params) }); return { changes: db.changes() }; },
		get: <T>(sql: string, ...params: Value[]) => all<T>(sql, params)[0],
		all: <T>(sql: string, ...params: Value[]) => all<T>(sql, params),
		// As bun:sqlite does, a transaction inside another is a savepoint.
		transaction: fn => {
			const level = depth, name = 'mob_' + level;
			db.exec(level ? `SAVEPOINT ${name}` : 'BEGIN');
			depth = level + 1;
			try {
				let result;
				try { result = fn(); } catch (e) { rollback(level, name); throw e; }
				// A failed COMMIT or RELEASE leaves the transaction open, so it is rolled back too.
				try { db.exec(level ? `RELEASE ${name}` : 'COMMIT'); } catch (e) { rollback(level, name); throw e; }
				return result;
			} finally {
				depth = level;
			}
		},
		close: () => db.close(),
	};
}
