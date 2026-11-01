// SQL is the SQLite connection a store runs on: bun:sqlite on a computer,
// sqlite-wasm in a browser. Calls are synchronous, as both are.
export type Value = string | number | bigint | boolean | null;

export interface SQL {
	exec(sql: string): void;
	run(sql: string, ...params: Value[]): { changes: number };
	get<T = Record<string, unknown>>(sql: string, ...params: Value[]): T | undefined;
	all<T = Record<string, unknown>>(sql: string, ...params: Value[]): T[];
	/** transaction runs fn in one transaction, rolled back when it throws. */
	transaction<T>(fn: () => T): T;
	close(): void;
}

/** randomHex is n random bytes as lowercase hex. */
export const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

/** newID is a new row ID: 16 random bytes as hex. */
export const newID = () => randomHex(16);

/** NotFound is a row that does not exist, as Go's sql.ErrNoRows. */
export class NotFound extends Error {
	constructor(what = 'conversation not found') { super(what); }
}
