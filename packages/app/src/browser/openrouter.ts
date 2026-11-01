// Signing in with OpenRouter, so the browser runner gets a key without the
// user copying one: OpenRouter's PKCE flow sends the user back here with a
// code, which only the verifier kept in this tab turns into a key.
import type { OpenRouterSignIn } from './providers';
import { base64url } from '@mob/core/relay';

const verifierKey = 'mob-openrouter-verifier';

/** startOpenRouter leaves for OpenRouter's sign-in, which returns to this page with ?code=. */
export async function startOpenRouter() {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
	sessionStorage.setItem(verifierKey, verifier);
	const back = window.location.origin + window.location.pathname;
	window.location.assign(`https://openrouter.ai/auth?callback_url=${encodeURIComponent(back)}&code_challenge=${challenge}&code_challenge_method=S256`);
}

// The sign-in is read once per page load: a workspace that renders again, or
// suspends while it loads, still finds it until finishOpenRouterSignIn.
let pending: OpenRouterSignIn | null | undefined;

/** pendingOpenRouterSignIn returns a sign-in OpenRouter just finished, and removes its code from the address. */
export function pendingOpenRouterSignIn(): OpenRouterSignIn | undefined {
	if (pending === undefined) pending = read();
	return pending ?? undefined;
}

/** finishOpenRouterSignIn forgets the sign-in once its code is used: OpenRouter takes each code once. */
export function finishOpenRouterSignIn() {
	pending = null;
}

function read(): OpenRouterSignIn | null {
	const url = new URL(window.location.href);
	const code = url.searchParams.get('code');
	let verifier: string | null = null;
	try { verifier = sessionStorage.getItem(verifierKey); sessionStorage.removeItem(verifierKey); } catch { /* no sign-in to finish */ }
	if (!code) return null;
	url.searchParams.delete('code');
	window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
	return verifier ? { code, verifier } : null;
}
