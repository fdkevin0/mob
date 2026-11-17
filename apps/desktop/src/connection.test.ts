import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mobBinary, parseConnection } from './connection';
import { calfBitmap } from './icon';

const token = 'x'.repeat(64);
const unix = test.skipIf(process.platform === 'win32');

describe('parseConnection', () => {
	test('reads the last JSON line', () => {
		expect(parseConnection(`starting\n{"url":"http://127.0.0.1:8787","token":"${token}"}\n`)).toEqual({ url: 'http://127.0.0.1:8787', token });
	});
	test('refuses anything but a loopback HTTP service with a full token', () => {
		for (const out of [
			'', 'not json', `{"url":"https://127.0.0.1:8787","token":"${token}"}`,
			`{"url":"http://example.com","token":"${token}"}`, '{"url":"http://127.0.0.1:8787","token":"short"}',
		]) expect(() => parseConnection(out)).toThrow();
	});
});

test('mobBinary prefers MOB_BINARY, then the bundled binary, then PATH', () => {
	expect(mobBinary('/nowhere', 'linux', { MOB_BINARY: '/x/mob' })).toBe('/x/mob');
	expect(mobBinary('/nowhere', 'linux', {})).toBe('mob');
	expect(mobBinary(join(import.meta.dir, '..', 'test'), 'linux', {})).toBe(join(import.meta.dir, '..', 'test', 'bin', 'mob'));
});

test('calfBitmap scales the 16 by 16 logo', () => {
	const { width, height, data } = calfBitmap(2);
	expect([width, height, data.length]).toEqual([32, 32, 32 * 32 * 4]);
	expect(data[3]).toBe(0);
});

unix('stage.ts places binaries by architecture and replaces stale directories', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mob-desktop-'));
	const x64Src = join(dir, 'x64-src');
	const arm64Src = join(dir, 'arm64-src');
	writeFileSync(x64Src, 'x64');
	writeFileSync(arm64Src, 'arm64');

	const multi = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'stage.ts'), '--dir', dir, '--x64', x64Src, '--arm64', arm64Src]);
	expect(multi.exitCode).toBe(0);
	expect(readFileSync(join(dir, 'bin/x64/mob'), 'utf8')).toBe('x64');
	expect(readFileSync(join(dir, 'bin/arm64/mob'), 'utf8')).toBe('arm64');
	expect(statSync(join(dir, 'build/icon.png')).size).toBeGreaterThan(0);

	const single = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'stage.ts'), '--dir', dir], {
		env: { ...process.env, MOB_BINARY: x64Src },
	});
	expect(single.exitCode).toBe(0);
	expect(readdirSync(join(dir, 'bin'))).toEqual([process.arch]);
	expect(readFileSync(join(dir, `bin/${process.arch}/mob`), 'utf8')).toBe('x64');

	rmSync(dir, { recursive: true, force: true });
});
