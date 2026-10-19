import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();

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

// Takes the waiting link out of storage and goes on to the app with it, so a
// link is used once.
export function openApp() {
	let hash = '';
	try {
		hash = sessionStorage.getItem(offerKey) ?? '';
		sessionStorage.removeItem(offerKey);
	} catch { /* nothing kept */ }
	window.location.assign(`/app${hash}`);
}

export function pendingOffer() {
	try { return sessionStorage.getItem(offerKey) !== null; } catch { return false; }
}
