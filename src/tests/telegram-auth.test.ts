import { describe, it, expect } from 'vitest';
import { verifyInitData } from '../features/miniapp/telegram-auth';

const BOT_TOKEN = '123456:test-token';

async function hmacHex(key: CryptoKey, data: string): Promise<string> {
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Independently reimplements Telegram's `initData` signing algorithm (not by
 * calling into `telegram-auth.ts`) so a bug shared between signer and
 * verifier can't make this test tautologically pass.
 */
async function signInitData(botToken: string, fields: Record<string, string>): Promise<string> {
	const dataCheckString = Object.keys(fields)
		.sort()
		.map((k) => `${k}=${fields[k]}`)
		.join('\n');
	const macKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	const secretHex = await hmacHex(macKey, botToken);
	const secretBytes = new Uint8Array(secretHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
	const secretKey = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const hash = await hmacHex(secretKey, dataCheckString);
	return new URLSearchParams({ ...fields, hash }).toString();
}

function nowSeconds(): string {
	return String(Math.floor(Date.now() / 1000));
}

/**
 * Pins the pure `verifyInitData` seam (ADR-0036): the Telegram WebApp
 * `initData` HMAC scheme, staleness check, and user-id extraction.
 */
describe('verifyInitData', () => {
	it('verifies valid initData and extracts the user id', async () => {
		const initData = await signInitData(BOT_TOKEN, { auth_date: nowSeconds(), user: JSON.stringify({ id: 42 }) });
		const result = await verifyInitData(BOT_TOKEN, initData);
		expect(result?.userId).toBe(42);
	});

	it('rejects a tampered hash', async () => {
		const initData = await signInitData(BOT_TOKEN, { auth_date: nowSeconds(), user: JSON.stringify({ id: 42 }) });
		const params = new URLSearchParams(initData);
		const hash = params.get('hash')!;
		params.set('hash', (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1));
		expect(await verifyInitData(BOT_TOKEN, params.toString())).toBeNull();
	});

	it('rejects the wrong bot token', async () => {
		const initData = await signInitData(BOT_TOKEN, { auth_date: nowSeconds(), user: JSON.stringify({ id: 42 }) });
		expect(await verifyInitData('other-token', initData)).toBeNull();
	});

	it('rejects a missing hash', async () => {
		const params = new URLSearchParams({ auth_date: nowSeconds(), user: JSON.stringify({ id: 42 }) });
		expect(await verifyInitData(BOT_TOKEN, params.toString())).toBeNull();
	});

	it('rejects an auth_date older than the max age; accepts within a looser one', async () => {
		const staleAuthDate = String(Math.floor(Date.now() / 1000) - 7200);
		const initData = await signInitData(BOT_TOKEN, { auth_date: staleAuthDate, user: JSON.stringify({ id: 42 }) });
		expect(await verifyInitData(BOT_TOKEN, initData, 3600)).toBeNull();
		expect(await verifyInitData(BOT_TOKEN, initData, 999999)).not.toBeNull();
	});

	it('rejects a missing user field', async () => {
		const initData = await signInitData(BOT_TOKEN, { auth_date: nowSeconds() });
		expect(await verifyInitData(BOT_TOKEN, initData)).toBeNull();
	});

	it('rejects malformed user JSON', async () => {
		const initData = await signInitData(BOT_TOKEN, { auth_date: nowSeconds(), user: 'not-json' });
		expect(await verifyInitData(BOT_TOKEN, initData)).toBeNull();
	});
});