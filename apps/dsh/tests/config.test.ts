import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPlugins } from '../src/config';

test('configuration rejects invalid entries before importing any plugin', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'mob-dsh-'));
	const file = join(dir, 'plugins.json');
	try {
		for (const input of [
			null,
			{},
			[{ module: '' }],
			[{ module: 5 }],
			[{ module: 'missing', enabled: false }],
			[{ module: 'missing' }, null],
		]) {
			await writeFile(file, JSON.stringify(input));
			await assert.rejects(loadPlugins(file), /configuration must be|Each DSH plugin/);
		}
		await writeFile(file, 'not json');
		await assert.rejects(loadPlugins(file), SyntaxError);
		await writeFile(file, '[{"module":"./not-installed.ts"}]');
		await assert.rejects(loadPlugins(file), /not-installed/);
		await writeFile(file, '[]');
		assert.deepEqual(await loadPlugins(file), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
