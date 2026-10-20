// Offline integration: real Worker/D1/Durable Object, Go runner and browser crypto.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptedFetch, newKey, seal } from '../webapp/src/chat/remote';

// Reuse the Workers runtime already bundled with the pinned Wrangler dependency.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const dir = await mkdtemp(join(tmpdir(), 'mob-runner-'));
const children: ChildProcess[] = [];
const authSecret = 'offline-test-secret-that-is-at-least-32-characters';
let mf: InstanceType<typeof Miniflare> | undefined;
const originalFetch = globalThis.fetch;
async function until(check: () => Promise<boolean>, description: string) {
	const deadline = Date.now() + 15_000;
	while (!(await check())) {
		assert(Date.now() < deadline, `Timed out: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}
try {
	const built = await Bun.build({ entrypoints: ['worker/index.ts'], target: 'browser', external: ['cloudflare:workers', 'node:*'] });
	assert(built.success, String(built.logs));
	mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: 'mob',
					modules: true,
					script: await built.outputs[0].text(),
					compatibilityDate: '2026-10-01',
					compatibilityFlags: ['nodejs_compat'],
					d1Databases: { DB: 'runner-test' },
					durableObjects: { RUNNERS: { className: 'RunnerRelay', useSQLite: true } },
					bindings: {
						BETTER_AUTH_SECRET: authSecret,
						GITHUB_CLIENT_ID: 'test',
						GITHUB_CLIENT_SECRET: 'test',
						TURNSTILE_SITE_KEY: 'test',
						TURNSTILE_SECRET_KEY: 'test',
					},
				},
			],
		}),
	);
	const origin = (await mf.ready).origin;
	const db = await mf.getD1Database('DB');
	for (const file of ['0001_better_auth.sql', '0002_runners.sql']) {
		const sql = (await readFile(`worker/migrations/${file}`, 'utf8')).replace(/^--.*$/gm, '');
		for (const statement of sql.split(';').filter((s) => s.trim())) await db.prepare(statement).run();
	}
	const cookies: Record<string, string> = {};
	for (const user of ['alice', 'bob']) {
		await db
			.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)')
			.bind(user, user, `${user}@example.test`, new Date().toISOString(), new Date().toISOString())
			.run();
		const token = `test-session-${user}`;
		await db
			.prepare('INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
			.bind(user, token, user, new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(), new Date().toISOString())
			.run();
		cookies[user] =
			`better-auth.session_token=${encodeURIComponent(token + '.' + createHmac('sha256', authSecret).update(token).digest('base64'))}`;
	}
	const account = (path: string, user = 'alice', init?: RequestInit) =>
		originalFetch(origin + '/api/runners' + path, { ...init, headers: { Cookie: cookies[user], Origin: origin, ...init?.headers } });
	assert.equal((await originalFetch(origin + '/api/runners')).status, 401);
	const created = await account('', 'alice', { method: 'POST' });
	assert.equal(created.status, 201, await created.clone().text());
	const pair = (await created.json()) as { id: string; code: string };
	const key = newKey();
	for (const path of [`/${pair.id}`, `/${pair.id}/relay`])
		assert.equal((await account(path, 'bob', path.endsWith('relay') ? { method: 'POST', body: '{}' } : undefined)).status, 404);
	assert.equal((await account(`/${pair.id}`, 'bob', { method: 'DELETE' })).status, 404);
	assert.deepEqual(await (await account('', 'bob')).json(), []);
	assert.equal(
		(await originalFetch(origin + '/api/runners', { method: 'POST', headers: { Cookie: cookies.alice, Origin: 'https://evil.test' } }))
			.status,
		403,
	);
	assert.equal((await originalFetch(origin + '/api/runners', { method: 'POST', headers: { Cookie: cookies.alice } })).status, 403);

	const binary = join(dir, 'mob');
	const build = spawnSync('go', ['build', '-o', binary, './cmd/mob'], { stdio: 'inherit' });
	assert.equal(build.status, 0);
	await writeFile(join(dir, 'config.yaml'), 'demo: true\n', { mode: 0o600 });
	const env = {
		...process.env,
		MOB_CONFIG: join(dir, 'config.yaml'),
		MOB_DATA_DIR: dir,
		MOB_STATE_DIR: dir,
		MOB_DEMO: '1',
		MOB_TOKEN: '',
		MOB_GATEWAY_URL: '',
	};
	const pairing = spawnSync(binary, ['runner', 'pair'], {
		env,
		input: JSON.stringify({ url: origin, ...pair, key }) + '\n',
		encoding: 'utf8',
	});
	assert.equal(pairing.status, 0, pairing.stderr);
	const credentialFile = await readFile(join(dir, 'runner.json'), 'utf8');
	assert.equal(JSON.parse(credentialFile).key, key);
	const repeated = await originalFetch(origin + '/api/runners/claim', { method: 'POST', body: JSON.stringify({ code: pair.code }) });
	assert.equal(repeated.status, 403);
	const rows = await db.prepare('SELECT * FROM runner').all();
	assert(!JSON.stringify(rows).includes(key));
	assert(!JSON.stringify(rows).includes(pair.code));
	assert(!JSON.stringify(rows).includes(JSON.parse(credentialFile).token));

	const service = spawn(binary, ['serve', '--addr=127.0.0.1:0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(service);
	const localURL = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('local Mob startup timeout')), 15000);
		service.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`Mob exited ${code}`));
		});
		let output = '';
		service.stdout!.on('data', (chunk) => {
			output += chunk;
			const match = output.match(/Mob: (http:\/\/\S+)/);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
	});
	const runner = spawn(binary, ['runner', '--addr=' + new URL(localURL).host], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(runner);
	async function currentSession() {
		return ((await (await account(`/${pair.id}`)).json()) as { session: string | null }).session;
	}
	await until(async () => Boolean(await currentSession()), 'runner online');
	const session = (await currentSession())!;

	// Browser requests use cookies for ownership; only encrypted payloads enter the relay.
	Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
	const wire: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, origin);
		const headers = new Headers(init?.headers);
		headers.set('Cookie', cookies.alice);
		headers.set('Origin', origin);
		if (url.pathname.endsWith('/relay')) wire.push(String(init?.body));
		return originalFetch(url, { ...init, headers });
	}) as typeof fetch;
	const remote = encryptedFetch(pair.id, key);
	const apiURL = `${origin}/api/runners/${pair.id}/api`;
	const config = await remote(apiURL + '/config');
	assert.equal(config.status, 200);
	await config.text();
	const conversation = await remote(apiURL + '/conversations', { method: 'POST', body: '{}' });
	const { id } = (await conversation.json()) as { id: string };
	const prompt = 'private-runner-prompt-你好';
	const chat = await remote(apiURL + '/chat', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, text: prompt, requestId: crypto.randomUUID() }),
	});
	assert.equal(chat.status, 200);
	assert.match(await chat.text(), /\[DONE\]/);
	for (const path of ['/pairing', '/token/rotate', '/runtime/stop']) {
		const denied = await remote(apiURL + path, { method: 'POST', body: '{}' });
		assert.equal(denied.status, 403);
		await denied.text();
	}
	const localToken = (await readFile(join(dir, 'token'), 'utf8')).trim();
	for (const secret of [prompt, '/api/chat', key, localToken]) assert(!wire.join('').includes(secret));

	// An authenticated replay disconnects the runner; it must not execute twice.
	const envelope = await seal(
		key,
		pair.id,
		'request',
		{ v: 1, session, id: crypto.randomUUID(), seq: 0, final: true },
		{
			method: 'POST',
			path: '/api/conversations',
			headers: {},
			body: '{}',
			expires: Date.now() + 30000,
		},
	);
	const first = await account(`/${pair.id}/relay`, 'alice', { method: 'POST', body: JSON.stringify(envelope) });
	assert.equal(first.status, 200);
	await first.text();
	const replay = await account(`/${pair.id}/relay`, 'alice', { method: 'POST', body: JSON.stringify(envelope) });
	let incomplete = false;
	try {
		await replay.text();
	} catch {
		incomplete = true;
	}
	assert(replay.status !== 200 || incomplete, 'replay should fail the stream');
	await until(async () => {
		const next = await currentSession();
		return Boolean(next && next !== session);
	}, 'fresh session after reconnect');
	const stale = await account(`/${pair.id}/relay`, 'alice', { method: 'POST', body: JSON.stringify(envelope) });
	assert.equal(stale.status, 409);

	assert.equal((await account(`/${pair.id}`, 'alice', { method: 'DELETE' })).status, 200);
	assert.equal((await account(`/${pair.id}`)).status, 404);
	const credentials = JSON.parse(credentialFile);
	const revoked = await originalFetch(`${origin}/api/runners/${pair.id}/connect`, {
		headers: {
			Upgrade: 'websocket',
			Connection: 'Upgrade',
			'Sec-WebSocket-Version': '13',
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			Authorization: `Bearer ${credentials.token}`,
		},
	});
	assert.equal(revoked.status, 401);
	console.log(
		'Runner integration passed: account isolation, one-time pairing, Go/browser encrypted chat, local-only boundaries, replay/reconnect and revocation.',
	);
} finally {
	globalThis.fetch = originalFetch;
	for (const child of children.reverse()) {
		if (child.exitCode === null) {
			const done = once(child, 'exit');
			child.kill('SIGTERM');
			await done;
		}
	}
	await mf?.dispose();
	await rm(dir, { recursive: true, force: true });
}
