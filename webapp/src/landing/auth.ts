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

// Where to go once signed in, carrying a waiting link along.
export function appURL() {
	let hash = '';
	try { hash = sessionStorage.getItem(offerKey) ?? ''; } catch { /* nothing kept */ }
	return `/app${hash}`;
}

export function openApp() {
	const url = appURL();
	try { sessionStorage.removeItem(offerKey); } catch { /* nothing kept */ }
	window.location.assign(url);
}

export function pendingOffer() {
	try { return sessionStorage.getItem(offerKey) !== null; } catch { return false; }
}
