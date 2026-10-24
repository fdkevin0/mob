import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/local';

test.skipIf(process.platform === 'win32')('the database and its journals are owner-only in a directory others can read', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mob-local-'));
	try {
		chmodSync(dir, 0o755);
		const path = join(dir, 'mob.sqlite');
		const mode = (file: string) => statSync(file).mode & 0o777;
		const store = openStore(path);
		store.create();
		for (const file of [path, path + '-wal', path + '-shm']) expect(mode(file)).toBe(0o600);
		store.db.close();
		// A database an older release left readable is tightened when it opens.
		chmodSync(path, 0o644);
		const again = openStore(path);
		expect(mode(path)).toBe(0o600);
		again.create();
		expect(mode(path + '-wal')).toBe(0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
