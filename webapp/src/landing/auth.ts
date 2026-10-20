import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';

export const authClient = createAuthClient({ plugins: [passkeyClient()] });

// Better Auth errors carry a code when the server or WebAuthn names the failure.
export const errorCode = (error: { message?: string }) => 'code' in error ? String(error.code) : undefined;

export type Site = { turnstileSiteKey: string; ready: boolean };

export async function loadSite(): Promise<Site> {
	const response = await fetch('/api/site');
	if (!response.ok) throw new Error(`The site answered ${response.status}.`);
	return response.json();
}

// A #offer= link from `mob open --web` waits here while the visitor signs in.
const offerKey = 'mob.pendingOffer';

export function keepOffer() {
	const hash = window.location.hash;
	if (!new URLSearchParams(hash.slice(1)).has('offer')) return false;
	try { sessionStorage.setItem(offerKey, hash); } catch { /* the link is used once anyway */ }
	window.history.replaceState(null, '', window.location.pathname + window.location.search);
	return true;
}

// GitHub sends the visitor back here, never to a URL holding the offer, so the
// pairing code stays in this browser.
export const signedInURL = '/?signin=done';

// A page that sent the visitor to sign in, such as /account, waits here.
const returnKey = 'mob.afterSignIn';
const returnPages = ['/account'];

export function returnAfterSignIn(path: string) {
	if (!returnPages.includes(path)) return;
	try { sessionStorage.setItem(returnKey, path); } catch { /* the app opens instead */ }
}

// Takes the waiting link out of storage and goes on to the app with it, so a
// link is used once. Without a link, a page waiting for the sign-in opens instead.
export function openApp() {
	let hash = '';
	let back = '';
	try {
		hash = sessionStorage.getItem(offerKey) ?? '';
		back = sessionStorage.getItem(returnKey) ?? '';
		sessionStorage.removeItem(offerKey);
		sessionStorage.removeItem(returnKey);
	} catch { /* nothing kept */ }
	window.location.assign(!hash && returnPages.includes(back) ? back : `/app${hash}`);
}

export function pendingOffer() {
	try { return sessionStorage.getItem(offerKey) !== null; } catch { return false; }
}
