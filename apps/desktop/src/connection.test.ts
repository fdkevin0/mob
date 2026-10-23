import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mobBinary, parseConnection } from './connection';
import { calfBitmap } from './icon';

const token = 'x'.repeat(64);

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
