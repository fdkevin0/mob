import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loader, reference } from '../src/config';

test('the environment reference is current', () => {
	// Regenerate with bun run generate:configdocs.
	expect(readFileSync(join(import.meta.dir, '../../../docs/environment-variables.md'), 'utf8')).toBe(reference());
});

test('agents run with full permission only in a cloud environment', () => {
	const remote = process.env.CLAUDE_CODE_REMOTE;
	const read = (confinement: string) => new Loader({ config: join(import.meta.dir, 'missing.yaml'), 'agents.confinement': confinement, data_dir: '/tmp/mob-config-test', state_dir: '/tmp/mob-config-test' }).read(false).agents.confinement;
	try {
		delete process.env.CLAUDE_CODE_REMOTE;
		expect(read('host')).toBe('host');
		expect(() => read('cloud')).toThrow('agents.confinement cloud needs a Claude Code cloud environment');
		expect(() => read('vm')).toThrow('agents.confinement must be host or cloud');
		process.env.CLAUDE_CODE_REMOTE = 'true';
		expect(read('cloud')).toBe('cloud');
	} finally {
		if (remote === undefined) delete process.env.CLAUDE_CODE_REMOTE;
		else process.env.CLAUDE_CODE_REMOTE = remote;
	}
});

test('nested configuration keys flatten to dotted keys', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mob-cfg-'));
	const cfgPath = join(dir, 'mob.yaml');
	await Bun.write(cfgPath, 'agents:\n  confinement: host\n');
	chmodSync(cfgPath, 0o600);
	try {
		const env = new Loader({ config: cfgPath, data_dir: dir, state_dir: dir }).read(true);
		expect(env.agents.confinement).toBe('host');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
