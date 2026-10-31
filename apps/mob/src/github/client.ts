// Talking to GitHub as the Mob GitHub App. usemob.app keeps the app's key;
// this runner asks it for an installation token for one repository and only
// the permissions a call needs, keeps it in this process (never in an agent's
// environment or a worktree's git config) and drops it before it expires.
import type { Credentials } from '../runner/relay';

/** Grant is the permissions a token is asked for, as GitHub names them. */
export type Grant = Record<string, 'read' | 'write'>;

/** Client is what the GitHub plugin needs of GitHub, so tests can stand in for it. */
export interface Client {
	api<T>(repo: string, grant: Grant, path: string, init?: RequestInit): Promise<T>;
}

/** GitHubError is GitHub's, or usemob.app's, refusal. */
export class GitHubError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

const api = 'https://api.github.com';

export class GitHub implements Client {
	private tokens = new Map<string, { token: string; expires: number }>();
	constructor(private credentials: () => Credentials, private fetcher: typeof fetch = fetch) {}

	/** token is an installation token for repo with grant, from usemob.app, reused until five minutes before it expires. */
	async token(repo: string, grant: Grant): Promise<string> {
		const key = repo.toLowerCase() + ' ' + JSON.stringify(Object.entries(grant).sort());
		const now = Date.now();
		const cached = this.tokens.get(key);
		if (cached && cached.expires - 5 * 60_000 > now) return cached.token;
		const c = this.credentials();
		const res = await this.fetcher(c.url + '/api/github/token', {
			method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
			headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ repo, permissions: { metadata: 'read', ...grant } }),
		});
		const out = await res.json().catch(() => ({})) as { token?: unknown; expiresAt?: unknown; error?: unknown };
		if (!res.ok || typeof out.token !== 'string') throw new GitHubError(res.status, `usemob.app gave no token for ${repo}: ${typeof out.error === 'string' ? out.error : 'HTTP ' + res.status}`);
		const expires = Date.parse(String(out.expiresAt)) || now + 30 * 60_000;
		this.tokens.set(key, { token: out.token, expires });
		return out.token;
	}

	async api<T>(repo: string, grant: Grant, path: string, init: RequestInit = {}): Promise<T> {
		const token = await this.token(repo, grant);
		const headers = new Headers(init.headers);
		headers.set('Authorization', 'Bearer ' + token);
		headers.set('Accept', 'application/vnd.github+json');
		headers.set('X-GitHub-Api-Version', '2022-11-28');
		const res = await this.fetcher(api + path, { ...init, headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30_000) });
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			let message = text.slice(0, 300);
			try { message = String(JSON.parse(text).message ?? message); } catch { /* not JSON */ }
			throw new GitHubError(res.status, `GitHub ${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${message}`.trim());
		}
		return res.status === 204 ? undefined as T : await res.json() as T;
	}
}
