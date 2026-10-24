// Files Mob owns: written atomically with owner-only permissions, and locks
// that hold across processes.
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const windows = process.platform === 'win32';

/** writeAtomic replaces path so readers never see a partial file, keeping it owner-only. */
export function writeAtomic(path: string, data: string, backup = false) {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (backup && existsSync(path)) writeFileSync(path + '.bak', readFileSync(path), { mode: 0o600 });
	const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
	try {
		writeFileSync(tmp, data, { mode: 0o600 });
		if (!windows) chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}

/**
 * Lock is held across processes through SQLite's own file locking, which
 * works the same on every platform: an exclusive transaction on a lock
 * database stays open while the lock is held.
 */
export class Lock {
	private constructor(private db: Database) {}

	/** acquire waits up to waitMs for the lock; tryAcquire does not wait. */
	static acquire(path: string, waitMs = 30_000): Lock {
		const lock = Lock.open(path, waitMs);
		if (!lock) throw new Error('cannot lock ' + path);
		return lock;
	}
	static tryAcquire(path: string): Lock | undefined { return Lock.open(path, 0); }

	private static open(path: string, waitMs: number) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const db = new Database(path, { create: true });
		try {
			db.exec(`PRAGMA busy_timeout=${waitMs}`);
			db.exec('BEGIN EXCLUSIVE');
			return new Lock(db);
		} catch {
			db.close();
			return undefined;
		}
	}

	release() {
		try { this.db.exec('ROLLBACK'); } catch { /* already released */ }
		this.db.close();
	}
}

/** withLock runs fn holding the lock at path. */
export function withLock<T>(path: string, fn: () => T): T {
	const lock = Lock.acquire(path);
	try { return fn(); } finally { lock.release(); }
}
