// The Mob GitHub App. GitHub sends its webhooks here; this Worker checks
// them, keeps only what routes an event (which repository, issue or pull
// request, who did it), and passes that to the runner the installation is
// bound to. Titles, bodies and comments stay on GitHub: the runner reads them
// itself, with a short-lived installation token it asks for here, narrowed to
// one repository and to the permissions it needs.
import type { Env } from './auth';
import { deliveryID, repoName, type GitHubEvent } from '@mob/core/github';
import { appJWT, int, metadata, narrow, str, verify, type Payload } from './github-app';
import { hash, limitedText } from './runners';

export type { GitHubEvent };

export const githubReady = (env: Env) => Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_WEBHOOK_SECRET);

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
/** webhook answers GitHub: it checks the signature, records installations, and passes other events to the bound runner. */
export async function webhook(request: Request, env: Env): Promise<Response> {
	if (!githubReady(env)) return json({ error: 'GitHub App not configured' }, 503);
	if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
	// GitHub caps payloads at 25 MB; the events Mob reads are far smaller.
	const body = await limitedText(request, 4 << 20);
	if (body === null) return json({ error: 'Payload too large' }, 413);
	if (!(await verify(env.GITHUB_WEBHOOK_SECRET!, body, request.headers.get('X-Hub-Signature-256')))) return json({ error: 'Bad signature' }, 401);
	const event = request.headers.get('X-GitHub-Event') ?? '';
	const delivery = request.headers.get('X-GitHub-Delivery') ?? '';
	if (!deliveryID.test(delivery)) return json({ error: 'Bad delivery' }, 400);
	let p: Payload;
	try { p = JSON.parse(body); } catch { return json({ error: 'Bad payload' }, 400); }
	const now = Date.now();
	const fresh = await env.DB.prepare('INSERT OR IGNORE INTO github_delivery (id, received_at) VALUES (?, ?)').bind(delivery, now).run();
	if (!fresh.meta.changes) return json({ duplicate: true });
	// Forget deliveries older than GitHub redelivers (three days), now and then.
	if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM github_delivery WHERE received_at < ?').bind(now - 7 * 86_400_000).run();
	if (event === 'installation') return json(await installation(env, p, now));
	const meta = metadata(event, delivery, p, env.GITHUB_APP_SLUG!, now);
	if (!meta) return json({ ignored: true });
	const row = await env.DB.prepare('SELECT runner_id FROM github_installation WHERE id = ? AND suspended = 0 AND runner_id IS NOT NULL')
		.bind(meta.installation)
		.first<{ runner_id: string }>();
	if (!row) return json({ unbound: true });
	try {
		await env.RUNNERS.getByName(row.runner_id).github(meta);
	} catch (e) {
		// Not queued: forget the delivery, so GitHub's redelivery is not taken for a duplicate.
		await env.DB.prepare('DELETE FROM github_delivery WHERE id = ?').bind(delivery).run();
		throw e;
	}
	return json({ queued: true });
}

async function installation(env: Env, p: Payload, now: number) {
	const i = p.installation;
	const id = int(i?.id);
	if (!id) return { ignored: true };
	const action = str(p.action);
	if (action === 'deleted') {
		await env.DB.prepare('DELETE FROM github_installation WHERE id = ?').bind(id).run();
		return { deleted: true };
	}
	if (action === 'suspend' || action === 'unsuspend') {
		await env.DB.prepare('UPDATE github_installation SET suspended = ? WHERE id = ?').bind(action === 'suspend' ? 1 : 0, id).run();
		return { [action]: true };
	}
	if (action !== 'created' && action !== 'new_permissions_accepted') return { ignored: true };
	const account = i.account ?? {};
	if (!int(account.id) || !int(p.sender?.id)) return { ignored: true };
	await env.DB.prepare(
		'INSERT INTO github_installation (id, account_id, account_login, account_type, sender_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
			'ON CONFLICT(id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type',
	)
		.bind(id, account.id, str(account.login), str(account.type) || 'User', p.sender.id, now)
		.run();
	return { recorded: true };
}

/** token answers a runner's request for an installation token for one repository it is bound to. */
export async function token(request: Request, env: Env): Promise<Response> {
	if (!githubReady(env)) return json({ error: 'GitHub App not configured' }, 503);
	if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
	if (request.headers.has('Origin')) return json({ error: 'Runners only' }, 403);
	const bearer = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
	if (!bearer || bearer.length > 128) return json({ error: 'Unauthorized' }, 401);
	const runner = await env.DB.prepare('SELECT id FROM runner WHERE token_hash = ?').bind(await hash(bearer)).first<{ id: string }>();
	if (!runner) return json({ error: 'Unauthorized' }, 401);
	const raw = await limitedText(request, 2048);
	if (raw === null) return json({ error: 'Request too large' }, 413);
	let input: { repo?: unknown; permissions?: unknown };
	try { input = JSON.parse(raw); } catch { return json({ error: 'Invalid request' }, 400); }
	const repo = typeof input.repo === 'string' ? repoName.exec(input.repo) : null;
	if (!repo) return json({ error: 'repo must be owner/name' }, 400);
	const permissions = narrow(input.permissions);
	if (typeof permissions === 'string') return json({ error: permissions }, 400);
	const installation = await env.DB.prepare('SELECT id FROM github_installation WHERE runner_id = ? AND lower(account_login) = lower(?) AND suspended = 0')
		.bind(runner.id, repo[1])
		.first<{ id: number }>();
	if (!installation) return json({ error: `No installation of the Mob GitHub App on ${repo[1]} is bound to this runner` }, 403);
	const jwt = await appJWT(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!);
	const res = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'usemob.app' },
		// One repository, so a token never reaches the installation's other repositories.
		body: JSON.stringify({ repositories: [repo[2]], permissions }),
	});
	if (!res.ok) return json({ error: `GitHub refused the token (HTTP ${res.status}); is the app installed on ${input.repo}?` }, 502);
	const out = (await res.json()) as { token?: string; expires_at?: string; permissions?: unknown };
	return json({ token: out.token, expiresAt: out.expires_at, permissions: out.permissions });
}

// --- The account page ---

async function githubID(env: Env, userID: string) {
	const row = await env.DB.prepare(`SELECT "accountId" AS id FROM "account" WHERE "userId" = ? AND "providerId" = 'github'`).bind(userID).first<{ id: string }>();
	const id = Number(row?.id);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * installations answers the account page: GET lists the installations the
 * visitor may bind (those on their GitHub account, or that they installed)
 * and POST /api/github/installations/ID binds one to a runner of theirs, or
 * unbinds it with runner null.
 */
export async function installations(request: Request, env: Env, userID: string): Promise<Response> {
	const url = new URL(request.url);
	if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Invalid origin' }, 403);
	const gh = await githubID(env, userID);
	const mine = '(user_id = ?1 OR (user_id IS NULL AND (account_id = ?2 OR sender_id = ?2)))';
	if (url.pathname === '/api/github/installations' && request.method === 'GET') {
		const { results } = await env.DB.prepare(`SELECT id, account_login AS account, account_type AS type, runner_id AS runner, suspended FROM github_installation WHERE ${mine} ORDER BY created_at`)
			.bind(userID, gh ?? -1)
			.all();
		return json({
			app: env.GITHUB_APP_SLUG && githubReady(env) ? env.GITHUB_APP_SLUG : null,
			github: !!gh,
			installations: results.map(r => ({ ...r, suspended: !!r.suspended })),
		});
	}
	const match = /^\/api\/github\/installations\/(\d+)$/.exec(url.pathname);
	if (!match || request.method !== 'POST') return json({ error: 'Not found' }, 404);
	if (request.headers.get('Origin') !== url.origin) return json({ error: 'Origin required' }, 403);
	const raw = await limitedText(request, 256);
	let runner: unknown;
	try { runner = JSON.parse(raw || '{}').runner; } catch { return json({ error: 'Invalid request' }, 400); }
	if (runner !== null && (typeof runner !== 'string' || !/^[a-f0-9-]{36}$/.test(runner))) return json({ error: 'runner must be a runner ID or null' }, 400);
	if (runner && !(await env.DB.prepare('SELECT id FROM runner WHERE id = ? AND user_id = ? AND token_hash IS NOT NULL').bind(runner, userID).first()))
		return json({ error: 'Not your runner' }, 404);
	const result = await env.DB.prepare(`UPDATE github_installation SET user_id = ?1, runner_id = ?3 WHERE id = ?4 AND ${mine}`)
		.bind(userID, gh ?? -1, runner, Number(match[1]))
		.run();
	if (!result.meta.changes) return json({ error: 'Not found' }, 404);
	return json({ id: Number(match[1]), runner });
}
