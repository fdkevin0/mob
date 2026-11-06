import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
			await Bun.write(file, JSON.stringify(input));
			await expect(loadPlugins(file)).rejects.toThrow(/configuration must be|Each DSH plugin/);
		}
		await Bun.write(file, 'not json');
		await expect(loadPlugins(file)).rejects.toThrow(SyntaxError);
		await Bun.write(file, '[{"module":"./not-installed.ts"}]');
		await expect(loadPlugins(file)).rejects.toThrow(/not-installed/);
		await Bun.write(file, '[]');
		expect(await loadPlugins(file)).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
