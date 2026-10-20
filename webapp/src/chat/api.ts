import { MobClient, type Connection as LocalConnection } from '@mob/client';
import { encryptedFetch } from './remote';
export type Connection = LocalConnection & { runner?: { id: string; key: string } };

export { timeoutFor } from '@mob/client';
export type { Conversation, ChatMessage, Snapshot } from '@mob/client';
export type { Config } from './contracts';

declare global {
	interface Window {
		go?: { main?: { Desktop?: { Connection: () => Promise<Connection> } } };
	}
}

export function defaultURL() {
	return import.meta.env.DEV ? 'http://127.0.0.1:8787' : window.location.origin;
}

// Public Web offers loopback pairing and an account-scoped encrypted runner relay.
export function isPublicWeb() {
	return import.meta.env.MODE === 'public';
}

export type Offer = { url: string; code: string };
// Only accept Mob on this computer, never a server supplied by a crafted link.
export function readOffer(encoded: string): Offer {
	let offer: { v?: unknown; url?: unknown; code?: unknown };
	try {
		const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
		offer = JSON.parse(new TextDecoder().decode(bytes));
	} catch { throw new Error('This sign-in link is damaged. Run mob open --web again.'); }
	if (offer?.v !== 1 || typeof offer.url !== 'string' || typeof offer.code !== 'string' || !offer.code) throw new Error('This page does not understand the sign-in link. Run mob open --web again.');
	if (!isLocalMob(offer.url)) throw new Error('This sign-in link points to another computer, so it was ignored.');
	return { url: offer.url, code: offer.code };
}

export function isLocalMob(url: string) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.origin === url;
	} catch { return false; }
}

// A 401 means the token was replaced, such as by mob token rotate. The event names
// the rejected token so a late response for an older token cannot sign out a newer one.
export const unauthorizedEvent = 'mob:unauthorized';
export function webClient(connection: Connection) {
	return new MobClient(connection, {
		fetch: connection.runner ? encryptedFetch(connection.runner.id, connection.runner.key) : undefined,
		onUnauthorized: (token) => window.dispatchEvent(new CustomEvent<string>(unauthorizedEvent, { detail: token })),
	});
}

export function api<T>(connection: Connection, path: string, body?: object): Promise<T> {
	return webClient(connection).request<T>(path, body);
}
