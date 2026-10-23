// OAuth sign-in to MCP servers: Mob registers itself with the server's
// authorization server for a loopback address, shows the user the sign-in
// link, and keeps the tokens it gets so a restart need not sign in again.
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomBytes } from 'node:crypto';
import type { Server } from './config';

/** signInTimeout bounds how long Mob waits for the user to sign in. */
export const signInTimeout = 10 * 60_000;
/** grantsKey is the setting that keeps each server's OAuth sign-in. */
export const grantsKey = 'mcp_oauth';

/** signInHint tells the user what to do when the page a sign-in returns to does not open, as on a phone. */
export const signInHint = 'If the page you return to after signing in does not open, copy its address and send /signin followed by it.';

/** Settings keeps what Mob learns while it runs, such as OAuth tokens. */
export interface Settings {
	setting<T>(key: string): T | undefined;
	saveSetting(key: string, value: unknown): void;
}

/**
 * Grant is one server's OAuth sign-in: the client Mob registered for its
 * redirect address, and the latest tokens.
 */
export type Grant = { url: string; redirect?: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens };

export type Result = { code: string; state: string } | undefined;

/** Waiting is a sign-in that waits for its result, by redirect address. */
export type Waiting = { server: string; deliver: (r: Result) => boolean };

/** Grants keeps the sign-ins in settings. */
export class Grants {
	constructor(readonly settings?: Settings) {}
	all() { return this.settings?.setting<Record<string, Grant>>(grantsKey) ?? {}; }
	get(name: string) { return this.all()[name]; }
	/** save keeps a server's sign-in; undefined forgets it. */
	save(name: string, g?: Grant) {
		if (!this.settings) return;
		const all = this.all();
		if (g) all[name] = g; else delete all[name];
		this.settings.saveSetting(grantsKey, all);
	}
}

/**
 * SignIn authorizes one connection to an OAuth server. It starts with the
 * saved tokens, if any; when the server refuses them, the user signs in
 * again on a loopback address SignIn listens on while connecting.
 */
export class SignIn implements OAuthClientProvider {
	private listener?: ReturnType<typeof Bun.serve>;
	private redirect = '';
	private verifier = '';
	private expected = '';
	private result?: (r: Result) => void;
	private results: Result[] = [];
	private delivered = false;
	/** pending is the sign-in link the user was shown, once the server asked for one. */
	pending = '';

	constructor(readonly name: string, readonly server: Server, readonly grants: Grants,
		readonly waits: Map<string, Waiting>,
		/** shown tells the user to open the sign-in link. */
		readonly shown: (link: string) => void) {}

	/** open listens for the browser coming back, on the address Mob registered before when it is free. */
	open() {
		const saved = this.grant()?.redirect;
		const port = saved ? Number(new URL(saved).port) : 0;
		const fetch = (req: Request) => {
			const q = new URL(req.url).searchParams;
			let message = `You are signed in to ${this.name}. You can close this page.`;
			let r: Result = { code: q.get('code') ?? '', state: q.get('state') ?? '' };
			if (q.get('error') || !r.code) { message = `Signing in to ${this.name} failed: ${q.get('error') ?? ''} ${q.get('error_description') ?? ''}`; r = undefined; }
			this.deliver(r);
			return new Response(`<!doctype html><title>Mob</title><p>${Bun.escapeHTML(message)}</p>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
		};
		try { this.listener = Bun.serve({ hostname: '127.0.0.1', port, fetch }); } catch {
			this.listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
		}
		this.redirect = `http://127.0.0.1:${this.listener.port}/callback`;
		// A browser on another device cannot reach the loopback address, so the user may paste the address it was sent to instead.
		this.waits.set(this.redirect, { server: this.name, deliver: r => this.deliver(r) });
	}

	close() {
		this.waits.delete(this.redirect);
		void this.listener?.stop(true);
		this.listener = undefined;
	}

	/** deliver hands over the one result each sign-in link gets. */
	private deliver(r: Result) {
		if (!this.pending || this.delivered) return false;
		this.delivered = true;
		if (this.result) { this.result(r); this.result = undefined; } else this.results.push(r);
		return true;
	}

	/** code waits for the user to sign in and returns the authorization code. */
	code(signal: AbortSignal): Promise<string> {
		const settle = (r: Result) => {
			if (!r) throw new Error('signing in failed');
			if (this.expected && r.state !== this.expected) throw new Error('the sign-in answered for another request');
			return r.code;
		};
		if (this.results.length) return Promise.resolve(this.results.shift()).then(settle);
		return new Promise<Result>((resolve, reject) => {
			const timer = setTimeout(() => { this.result = undefined; reject(new Error('nobody signed in')); }, signInTimeout);
			const abort = () => { clearTimeout(timer); this.result = undefined; reject(signal.reason); };
			signal.addEventListener('abort', abort, { once: true });
			this.result = r => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(r); };
		}).then(settle);
	}

	private grant() {
		const g = this.grants.get(this.name);
		return g && g.url === this.server.url ? g : undefined;
	}

	private update(change: (g: Grant) => void) {
		const g: Grant = { ...this.grant() ?? { url: this.server.url! } };
		change(g);
		this.grants.save(this.name, g);
	}

	get redirectUrl() { return this.redirect; }
	get clientMetadata(): OAuthClientMetadata {
		return { client_name: 'Mob', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
	}
	state() { return this.expected = randomBytes(16).toString('base64url'); }
	/** clientInformation is the client registered for this redirect address; another address registers again. */
	clientInformation() { const g = this.grant(); return g?.redirect === this.redirect ? g.client : undefined; }
	saveClientInformation(client: OAuthClientInformationMixed) { this.update(g => { g.client = client; g.redirect = this.redirect; }); }
	tokens() { return this.grant()?.tokens; }
	saveTokens(tokens: OAuthTokens) { this.update(g => { g.tokens = tokens; }); }
	redirectToAuthorization(link: URL) { this.pending = link.toString(); this.delivered = false; this.shown(this.pending); }
	saveCodeVerifier(v: string) { this.verifier = v; }
	codeVerifier() { return this.verifier; }
	invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
		if (scope === 'verifier' || scope === 'discovery') return;
		if (scope === 'all') { this.grants.save(this.name); return; }
		this.update(g => { if (scope === 'client') { g.client = undefined; g.redirect = undefined; } g.tokens = undefined; });
	}
}

/** finishSignIn completes a sign-in with the address the user's browser was sent back to, and names the server. */
export function finishSignIn(waits: Map<string, Waiting>, address: string) {
	let u: URL | undefined;
	try { u = new URL(address.trim()); } catch { /* refused below */ }
	if (!u?.host) throw new Error('paste the whole address the browser was sent to, starting with http://127.0.0.1');
	const w = waits.get(`${u.protocol}//${u.host}${u.pathname}`);
	if (!w) throw new Error('no sign-in is waiting for that address; it may have finished or expired, so check /mcp');
	const q = u.searchParams;
	if (q.get('error') || !q.get('code')) throw new Error(`the address carries no sign-in: ${q.get('error') ?? ''} ${q.get('error_description') ?? ''}`);
	if (!w.deliver({ code: q.get('code')!, state: q.get('state') ?? '' })) throw new Error('that sign-in has already finished');
	return w.server;
}
