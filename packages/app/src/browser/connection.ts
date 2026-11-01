// The connection to the runner in this browser, without the runner's code,
// which loads only when the connection is used.
import type { Connection } from '../api';
import { randomHex } from '@mob/core/chat/sql';

/** browserURL is where requests to the browser runner go; they never reach the network. */
export const browserURL = 'http://localhost';

// The token keeps the browser's API as closed as any other Mob's: only this page holds it.
const tokenKey = 'mob-browser-token';
/** browserConnection is this browser's own Mob, with the token it was first opened with. */
export function browserConnection(): Connection {
	let token = '';
	try { token = localStorage.getItem(tokenKey) ?? ''; } catch { /* a new token each time */ }
	if (!token) {
		token = randomHex(32);
		try { localStorage.setItem(tokenKey, token); } catch { /* a new token each time */ }
	}
	return { url: browserURL, token, browser: true };
}

// Opening the browser runner is remembered too, so it reopens even when a local Mob's token is also saved.
const lastKey = 'mob-browser-last';
/** browserLast reports whether the browser runner was the last Mob this browser opened. */
export function browserLast() {
	try { return localStorage.getItem(lastKey) === '1'; } catch { return false; }
}
export function chooseBrowser(on: boolean) {
	try {
		if (on) localStorage.setItem(lastKey, '1');
		else localStorage.removeItem(lastKey);
	} catch { /* asked again next time */ }
}
