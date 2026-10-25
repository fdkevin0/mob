// Models of the visitor's own Cloudflare account, for Mob in the browser.
// Signing in with Cloudflare (or connecting it on the account page) leaves an
// OAuth token in the account table; this route lends it to the visitor's
// requests, so the token never reaches the page. The browser runner sees an
// OpenAI-compatible base URL: /api/ai/cloudflare/v1.
import type { Env } from './auth';
import { createAuth } from './auth';

const api = 'https://api.cloudflare.com/client/v4';
export const cloudflareBase = '/api/ai/cloudflare/v1';

type Envelope<T> = { success?: boolean; result?: T; errors?: { message?: string }[] };
type Model = { name?: unknown; task?: { name?: unknown }; properties?: { property_id?: unknown; value?: unknown }[] };

const failure = (status: number, message: string) => Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function cloudflareAI(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	// Only Mob's own pages may spend the visitor's account; a cross-site POST
	// carries another Origin.
	const origin = request.headers.get('Origin');
	if (origin && origin !== url.origin) return failure(403, 'Requests must come from Mob.');
	const auth = createAuth(env, url.origin);
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) return failure(401, 'Sign in again.');
	let token: string | undefined;
	try {
		const linked = (await auth.api.listUserAccounts({ headers: request.headers })).find(a => a.providerId === 'cloudflare');
		// getAccessToken refreshes an expired token with the stored refresh token.
		if (linked) token = (await auth.api.getAccessToken({ body: { accountId: linked.id }, headers: request.headers })).accessToken;
	} catch {
		token = undefined;
	}
	if (!token) return failure(403, 'Connect Cloudflare on your account page first.');
	const headers = { Authorization: 'Bearer ' + token };
	const account = await firstAccount(headers);
	if (typeof account !== 'string') return account;
	const path = url.pathname.slice(cloudflareBase.length);
	if (request.method === 'GET' && path === '/models') return models(account, headers);
	if (request.method === 'POST' && path === '/chat/completions') {
		const response = await fetch(`${api}/accounts/${account}/ai/v1/chat/completions`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: request.body,
		});
		const out = new Headers({ 'Cache-Control': 'no-store' });
		const type = response.headers.get('Content-Type');
		if (type) out.set('Content-Type', type);
		return new Response(response.body, { status: response.status, headers: out });
	}
	return failure(404, 'Not found.');
}

// firstAccount is the account the token reaches; Workers AI runs under one.
async function firstAccount(headers: Record<string, string>): Promise<string | Response> {
	const response = await fetch(`${api}/accounts?per_page=1`, { headers });
	const body = await response.json().catch(() => ({})) as Envelope<{ id?: unknown }[]>;
	const id = body.result?.[0]?.id;
	if (response.ok && typeof id === 'string') return id;
	return failure(response.status === 401 || response.status === 403 ? 403 : 502, 'Cloudflare did not list an account for this sign-in. Connect Cloudflare again and allow account access.');
}

// models lists Workers AI text generation models the way OpenAI's /models
// does, with OpenRouter's supported_parameters saying which take tools.
async function models(account: string, headers: Record<string, string>) {
	const response = await fetch(`${api}/accounts/${account}/ai/models/search?task=${encodeURIComponent('Text Generation')}&per_page=200`, { headers });
	const body = await response.json().catch(() => ({})) as Envelope<Model[]>;
	if (!response.ok || !Array.isArray(body.result)) return failure(502, body.errors?.[0]?.message || `Cloudflare did not list models (HTTP ${response.status}).`);
	const data = body.result.flatMap(m => {
		if (typeof m.name !== 'string') return [];
		const tools = m.properties?.some(p => p.property_id === 'function_calling' && String(p.value) === 'true');
		return [{ id: m.name, supported_parameters: tools ? ['tools'] : [] }];
	});
	return Response.json({ object: 'list', data }, { headers: { 'Cache-Control': 'no-store' } });
}
