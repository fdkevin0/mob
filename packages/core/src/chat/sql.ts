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

export function newID() {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** NotFound is a row that does not exist, as Go's sql.ErrNoRows. */
export class NotFound extends Error {
	constructor(what = 'conversation not found') { super(what); }
}
