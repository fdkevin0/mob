// The encrypted relay protocol between the owner's browser and a runner. The
// relay (apps/web/worker/relay.ts) sees only envelopes; the pairing key that
// seals them never leaves the browser and the runner. Every endpoint uses this
// one module, so the browser, the runner and the relay check frames alike.
// Written against Web Crypto and atob/btoa, so it runs in Bun, browsers and Workers.

/** Envelope is one sealed frame; v, runner, session, id, direction, seq and final are authenticated with it. */
export type Envelope = { v: 1; session: string; id: string; seq: number; final: boolean; nonce: string; data: string };

/** RelayRequest is what the browser asks the runner's local service, as it sealed it. */
export type RelayRequest = { method: string; path: string; headers?: Record<string, string[]> | null; body: string; expires: number };

/** RelayReply is one frame of an answer: the first carries the status and headers; error is set only on a final frame whose body is incomplete. */
export type RelayReply = { status: number; headers?: Record<string, string[]>; body: string; error?: string };

/** Direction says which way a frame travels; it is authenticated, so a request can never pass as a response. */
export type Direction = 'request' | 'response';

/** maxFrameData bounds a frame's sealed payload, in base64 characters. */
export const maxFrameData = 2 * 1024 * 1024;

const encoder = new TextEncoder();
const keyBytes = 32, nonceBytes = 12;

export function base64(bytes: Uint8Array) {
	let text = '';
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

export function unbase64(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

/** base64url is base64 safe in URLs, without padding, as PKCE and links use it. */
export const base64url = (bytes: Uint8Array) => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const unbase64url = (text: string) => unbase64(text.replace(/-/g, '+').replace(/_/g, '/'));

/** validRelayKey reports whether raw is a pairing key: exactly 32 bytes in canonical base64. */
export function validRelayKey(raw: unknown): raw is string {
	if (typeof raw !== 'string') return false;
	try { return unbase64(raw).length === keyBytes && base64(unbase64(raw)) === raw; } catch { return false; }
}

/** newRelayKey makes a pairing key. */
export const newRelayKey = () => base64(crypto.getRandomValues(new Uint8Array(keyBytes)));

/** relayKey imports a pairing key for sealing and opening frames. */
export async function relayKey(raw: string): Promise<CryptoKey> {
	if (!validRelayKey(raw)) throw new Error('runner key must be 32 base64-encoded bytes');
	return crypto.subtle.importKey('raw', unbase64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const asKey = (k: CryptoKey | string) => (typeof k === 'string' ? relayKey(k) : k);

/** validEnvelope checks a frame's shape: what the relay can check without the key. */
export function validEnvelope(value: unknown): value is Envelope {
	if (!value || typeof value !== 'object') return false;
	const e = value as Envelope;
	return (
		e.v === 1 &&
		typeof e.session === 'string' &&
		typeof e.id === 'string' &&
		Number.isSafeInteger(e.seq) && e.seq >= 0 &&
		typeof e.final === 'boolean' &&
		typeof e.nonce === 'string' && e.nonce.length === 16 &&
		typeof e.data === 'string' && e.data.length >= 24 && e.data.length <= maxFrameData
	);
}

const aad = (runner: string, direction: Direction, e: Omit<Envelope, 'nonce' | 'data'>) =>
	encoder.encode(JSON.stringify([e.v, runner, e.session, e.id, direction, e.seq, e.final]));

/** seal encrypts value as one frame from or to runner. */
export async function seal(k: CryptoKey | string, runner: string, direction: Direction, e: Omit<Envelope, 'nonce' | 'data'>, value: unknown): Promise<Envelope> {
	const nonce = crypto.getRandomValues(new Uint8Array(nonceBytes));
	const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(runner, direction, e) }, await asKey(k), encoder.encode(JSON.stringify(value)));
	return { v: e.v, session: e.session, id: e.id, seq: e.seq, final: e.final, nonce: base64(nonce), data: base64(new Uint8Array(sealed)) };
}

/** open authenticates and decrypts a frame; any change to it, or the wrong runner or direction, fails. */
export async function open<T = unknown>(k: CryptoKey | string, runner: string, direction: Direction, e: Envelope): Promise<T> {
	if (!e || e.v !== 1) throw new Error('unsupported encryption version');
	if (!Number.isSafeInteger(e.seq) || e.seq < 0 || typeof e.final !== 'boolean' || typeof e.session !== 'string' || typeof e.id !== 'string') throw new Error('invalid encrypted envelope');
	let nonce: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>;
	try { nonce = unbase64(e.nonce); data = unbase64(e.data); } catch { throw new Error('invalid encrypted envelope'); }
	if (nonce.length !== nonceBytes) throw new Error('invalid nonce');
	const key = await asKey(k);
	let plain: ArrayBuffer;
	try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(runner, direction, e) }, key, data); } catch {
		throw new Error('encrypted frame authentication failed');
	}
	return JSON.parse(new TextDecoder().decode(plain)) as T;
}
