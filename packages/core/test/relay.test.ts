import { expect, test } from 'bun:test';
import { base64, newRelayKey, open, relayKey, seal, unbase64, validEnvelope, validRelayKey } from '../src/relay';

const runner = '00000000-0000-4000-8000-000000000000';
const head = { v: 1 as const, session: 'a'.repeat(64), id: runner, seq: 0, final: true };

test('a frame opens only with its key, runner and direction', async () => {
	const key = newRelayKey();
	const e = await seal(key, runner, 'request', head, { text: 'private' });
	expect(validEnvelope(e)).toBe(true);
	expect(await open(key, runner, 'request', e)).toEqual({ text: 'private' });
	expect(await open(await relayKey(key), runner, 'request', e)).toEqual({ text: 'private' });
	await expect(open(key, runner, 'response', e)).rejects.toThrow('authentication failed');
	await expect(open(key, 'other', 'request', e)).rejects.toThrow('authentication failed');
	await expect(open(newRelayKey(), runner, 'request', e)).rejects.toThrow('authentication failed');
	for (const patch of [{ seq: 1 }, { final: false }, { session: 'b'.repeat(64) }, { id: 'x' }]) {
		await expect(open(key, runner, 'request', { ...e, ...patch })).rejects.toThrow('authentication failed');
	}
});

test('malformed frames are refused before decrypting', async () => {
	const key = newRelayKey();
	const e = await seal(key, runner, 'request', head, {});
	await expect(open(key, runner, 'request', { ...e, v: 2 as 1 })).rejects.toThrow('version');
	await expect(open(key, runner, 'request', { ...e, seq: -1 })).rejects.toThrow('invalid');
	await expect(open(key, runner, 'request', { ...e, nonce: base64(new Uint8Array(8)) })).rejects.toThrow('nonce');
	expect(validEnvelope({ ...e, data: '' })).toBe(false);
	expect(validEnvelope({ ...e, seq: 1.5 })).toBe(false);
});

test('pairing keys are exactly 32 bytes of canonical base64', async () => {
	expect(validRelayKey(newRelayKey())).toBe(true);
	expect(validRelayKey(base64(new Uint8Array(16)))).toBe(false);
	expect(validRelayKey('not base64!')).toBe(false);
	expect(validRelayKey(42)).toBe(false);
	await expect(relayKey(base64(new Uint8Array(31)))).rejects.toThrow('32');
	const bytes = crypto.getRandomValues(new Uint8Array(100_000));
	expect(unbase64(base64(bytes))).toEqual(bytes);
});
