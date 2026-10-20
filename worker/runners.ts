import type { Env } from './auth';

export async function hash(value: string) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
const secret = () => crypto.randomUUID() + crypto.randomUUID();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

// Claim and socket registration use a separate runner credential, never a browser session.
export async function runnerTransport(request: Request, env: Env): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname === '/api/runners/claim' && request.method === 'POST') {
		if (request.headers.has('Origin')) return json({ error: 'CLI only' }, 403);
		const raw = await limitedText(request, 1024);
		if (raw === null) return json({ error: 'Request too large' }, 413);
		let code: unknown;
		try {
			code = JSON.parse(raw).code;
		} catch {
			return json({ error: 'Invalid code' }, 400);
		}
		if (typeof code !== 'string' || code.length > 128) return json({ error: 'Invalid code' }, 400);
		const token = secret();
		const runner = await env.DB.prepare(
			'UPDATE runner SET token_hash = ?, code_hash = NULL WHERE code_hash = ? AND expires_at > ? AND token_hash IS NULL RETURNING id',
		)
			.bind(await hash(token), await hash(code), Date.now())
			.first<{ id: string }>();
		return runner ? json({ id: runner.id, token }) : json({ error: 'Pairing code expired or already used' }, 403);
	}
	const match = /^\/api\/runners\/([a-f0-9-]+)\/connect$/.exec(url.pathname);
	if (!match) return;
	if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
		return json({ error: 'WebSocket required' }, 400);
	const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
	if (!token || token.length > 128) return json({ error: 'Unauthorized' }, 401);
	const row = await env.DB.prepare('SELECT id FROM runner WHERE id = ? AND token_hash = ?')
		.bind(match[1], await hash(token))
		.first();
	if (!row) return json({ error: 'Unauthorized' }, 401);
	return env.RUNNERS.getByName(match[1]).fetch(new Request('https://runner/connect', request));
}

export async function accountRunners(request: Request, env: Env, userID: string): Promise<Response> {
	const url = new URL(request.url);
	// Browser control requests must originate from this site, including GET streams.
	if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Invalid origin' }, 403);
	if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') !== url.origin)
		return json({ error: 'Origin required' }, 403);
	if (url.pathname === '/api/runners') {
		if (request.method === 'GET') {
			const { results } = await env.DB.prepare('SELECT id FROM runner WHERE user_id = ? AND token_hash IS NOT NULL ORDER BY created_at')
				.bind(userID)
				.all<{ id: string }>();
			return json(await Promise.all(results.map(async (row) => ({ ...row, session: await env.RUNNERS.getByName(row.id).session() }))));
		}
		if (request.method === 'POST') {
			await env.DB.prepare('DELETE FROM runner WHERE token_hash IS NULL AND expires_at <= ?').bind(Date.now()).run();
			const id = crypto.randomUUID(),
				code = secret(),
				expiresAt = Date.now() + 300_000;
			// Bound registrations per account, including pending pairings.
			const result = await env.DB.prepare(
				'INSERT INTO runner (id,user_id,code_hash,expires_at,created_at) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM runner WHERE user_id = ?) < 20',
			)
				.bind(id, userID, await hash(code), expiresAt, Date.now(), userID)
				.run();
			return result.meta.changes ? json({ id, code, expiresAt }, 201) : json({ error: 'Runner limit reached (20)' }, 409);
		}
	}
	const match = /^\/api\/runners\/([a-f0-9-]+)(\/relay)?$/.exec(url.pathname);
	if (!match) return json({ error: 'Not found' }, 404);
	const owned = await env.DB.prepare('SELECT id FROM runner WHERE id = ? AND user_id = ?').bind(match[1], userID).first();
	if (!owned) return json({ error: 'Not found' }, 404);
	const stub = env.RUNNERS.getByName(match[1]);
	if (!match[2] && request.method === 'GET') return json({ session: await stub.session() });
	if (!match[2] && request.method === 'DELETE') {
		// Persist revocation before removing ownership, so an in-flight connect cannot revive it.
		await stub.revoke();
		await env.DB.prepare('DELETE FROM runner WHERE id = ? AND user_id = ?').bind(match[1], userID).run();
		return json({ revoked: true });
	}
	if (match[2] !== '/relay' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
	const body = await limitedText(request, 2 * 1024 * 1024);
	if (body === null) return json({ error: 'Request too large' }, 413);
	// The envelope is opaque: no local token, API path, headers or content reach the cloud.
	return stub.fetch(
		new Request('https://runner/relay', {
			method: 'POST',
			body,
			signal: request.signal,
		}),
	);
}

export async function limitedText(request: Request, limit: number): Promise<string | null> {
	if (!request.body) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder().decode(bytes);
}
