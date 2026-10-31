// Offline integration: real Worker/D1/Durable Object, mob runner and browser crypto.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encryptedFetch, newKey, seal } from '@mob/app/remote';

// Reuse the Workers runtime already bundled with the pinned Wrangler dependency.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const dir = await mkdtemp(join(tmpdir(), 'mob-runner-'));
const children: ChildProcess[] = [];
const authSecret = 'offline-test-secret-that-is-at-least-32-characters';
let mf: InstanceType<typeof Miniflare> | undefined;
const webhookSecret = 'offline-webhook-secret';
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
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
						GITHUB_APP_ID: '1',
						GITHUB_APP_SLUG: 'usemob',
						GITHUB_APP_PRIVATE_KEY: appKey,
						GITHUB_WEBHOOK_SECRET: webhookSecret,
					},
				},
			],
		}),
	);
	const origin = (await mf.ready).origin;
	const db = await mf.getD1Database('DB');
	for (const file of ['0001_better_auth.sql', '0002_runners.sql', '0003_passkey.sql', '0004_github.sql']) {
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

	// Passkeys join an account that already signed in; anyone may start a passkey sign-in.
	const authAPI = (path: string, user?: string) =>
		originalFetch(origin + '/api/auth' + path, { headers: { Origin: origin, ...(user ? { Cookie: cookies[user] } : {}) } });
	const signedOut = await originalFetch(origin + '/account', { redirect: 'manual' });
	assert.equal(signedOut.status, 302);
	assert.equal(signedOut.headers.get('Location'), origin + '/?signin=account');
	assert.equal((await authAPI('/passkey/generate-register-options')).status, 401);
	assert.equal((await authAPI('/passkey/list-user-passkeys')).status, 401);
	assert.deepEqual(await (await authAPI('/passkey/list-user-passkeys', 'alice')).json(), []);
	const registration = await authAPI('/passkey/generate-register-options', 'alice');
	assert.equal(registration.status, 200, await registration.clone().text());
	const options = (await registration.json()) as { rp: { id: string; name: string }; user: { name: string } };
	assert.deepEqual(options.rp, { id: new URL(origin).hostname, name: 'Mob' });
	assert.equal(options.user.name, 'alice@example.test');
	assert.equal((await authAPI('/passkey/generate-authenticate-options')).status, 200);
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
	const build = spawnSync('bun', ['run', 'build', '--outfile', binary], { cwd: dirname(Bun.resolveSync('@mob/mob/package.json', import.meta.dir)), stdio: 'inherit' });
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
	const runnerArgs = ['runner', '--addr=' + new URL(localURL).host];
	const runner = spawn(binary, runnerArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

	// An authenticated replay must not execute twice, nor disconnect the runner.
	const count = async () => {
		const list = await remote(apiURL + '/conversations');
		return ((await list.json()) as unknown[]).length;
	};
	const before = await count();
	const envelope = await seal(
		key,
		pair.id,
		'request',
		{ v: 1, session, id: crypto.randomUUID(), seq: 0, final: true },
		{
			// An import makes a conversation the list shows, which an empty new one is not.
			method: 'POST',
			path: '/api/conversations/import',
			headers: {},
			body: JSON.stringify({ v: 1, title: 'Replayed', model: '', summary: '', summaryThrough: '', facts: [], usage: [],
				messages: [{ id: 'replayed', role: 'user', parts: JSON.stringify([{ type: 'text', text: 'once' }]), status: 'complete', error: '', model: '', usage: '', kind: '' }] }),
			expires: Date.now() + 30000,
		},
	);
	const first = await account(`/${pair.id}/relay`, 'alice', { method: 'POST', body: JSON.stringify(envelope) });
	assert.equal(first.status, 200);
	await first.text();
	let answered = false;
	try {
		const replay = await account(`/${pair.id}/relay`, 'alice', {
			method: 'POST',
			body: JSON.stringify(envelope),
			signal: AbortSignal.timeout(1500),
		});
		await replay.text();
		answered = replay.ok;
	} catch {
		// The runner never answers a replay; the relay request times out.
	}
	assert(!answered, 'replay should get no answer');
	assert.equal(await count(), before + 1, 'replay executed');
	assert.equal(await currentSession(), session, 'replay disconnected the runner');

	// A restarted runner gets a fresh session, which old envelopes cannot use.
	runner.kill();
	await once(runner, 'exit');
	let restarted = spawn(binary, runnerArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(restarted);
	await until(async () => {
		const next = await currentSession();
		return Boolean(next && next !== session);
	}, 'fresh session after reconnect');
	const stale = await account(`/${pair.id}/relay`, 'alice', { method: 'POST', body: JSON.stringify(envelope) });
	assert.equal(stale.status, 409);

	// The GitHub App: signed webhooks, installations bound by their GitHub owner, and events that reach the runner, waiting while it is offline.
	await db.prepare(`INSERT INTO account (id,accountId,providerId,userId,createdAt,updatedAt) VALUES ('gh-alice','1001','github','alice',?,?)`)
		.bind(new Date().toISOString(), new Date().toISOString())
		.run();
	const hook = (event: string, payload: unknown, delivery = crypto.randomUUID(), secret = webhookSecret) => {
		const body = JSON.stringify(payload);
		return originalFetch(origin + '/api/github/webhook', {
			method: 'POST',
			body,
			headers: {
				'X-GitHub-Event': event,
				'X-GitHub-Delivery': delivery,
				'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
			},
		});
	};
	const installed = { action: 'created', installation: { id: 77, account: { id: 1001, login: 'fdkevin0', type: 'User' } }, sender: { id: 1001, login: 'fdkevin0' } };
	assert.equal((await hook('installation', installed, 'install-1', 'wrong')).status, 401);
	assert.deepEqual(await (await hook('installation', installed, 'install-1')).json(), { recorded: true });
	assert.deepEqual(await (await hook('installation', installed, 'install-1')).json(), { duplicate: true });
	const github = (path: string, user = 'alice', init?: RequestInit) =>
		originalFetch(origin + '/api/github' + path, { ...init, headers: { Cookie: cookies[user], Origin: origin, 'Content-Type': 'application/json', ...init?.headers } });
	assert.deepEqual(((await (await github('/installations')).json()) as { installations: unknown[] }).installations, [
		{ id: 77, account: 'fdkevin0', type: 'User', runner: null, suspended: false },
	]);
	assert.deepEqual(((await (await github('/installations', 'bob')).json()) as { installations: unknown[] }).installations, []);
	assert.equal((await github('/installations/77', 'bob', { method: 'POST', body: JSON.stringify({ runner: null }) })).status, 404);
	const issue = (delivery: string, label: string) =>
		hook('issues', {
			action: 'labeled', label: { name: label }, installation: { id: 77 }, repository: { full_name: 'fdkevin0/mob' },
			issue: { number: 5, title: 'private-issue-title', body: 'private-issue-body', author_association: 'OWNER' },
			sender: { id: 1001, login: 'fdkevin0', type: 'User' },
		}, delivery);
	assert.deepEqual(await (await issue('before-binding', 'bug')).json(), { unbound: true });
	assert.equal((await github('/installations/77', 'alice', { method: 'POST', body: JSON.stringify({ runner: pair.id }) })).status, 200);
	const local = new Database(join(dir, 'mob.sqlite'), { readonly: true });
	const delivered = (id: string) => !!local.query('SELECT 1 FROM deliveries WHERE id = ?').get('github:' + id);
	assert.deepEqual(await (await issue('while-online', 'bug')).json(), { queued: true });
	await until(async () => delivered('while-online'), 'GitHub event reaches the runner');
	restarted.kill();
	await once(restarted, 'exit');
	assert.deepEqual(await (await issue('while-offline', 'bug')).json(), { queued: true });
	assert(!delivered('while-offline'));
	restarted = spawn(binary, runnerArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(restarted);
	await until(async () => delivered('while-offline'), 'queued GitHub event delivered after reconnect');
	local.close();
	// Tokens: only a runner's credential, never workflows, and only for installations bound to it.
	const runnerToken = JSON.parse(credentialFile).token;
	const askToken = (body: unknown, bearer = runnerToken) =>
		originalFetch(origin + '/api/github/token', { method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer ' + bearer } });
	assert.equal((await askToken({ repo: 'fdkevin0/mob', permissions: { issues: 'read' } }, 'nope')).status, 401);
	assert.equal((await askToken({ repo: 'fdkevin0/mob', permissions: { workflows: 'write' } })).status, 400);
	assert.equal((await askToken({ repo: 'someone/else', permissions: { issues: 'read' } })).status, 403);
	assert.equal((await hook('installation', { ...installed, action: 'deleted' })).status, 200);
	assert.deepEqual(((await (await github('/installations')).json()) as { installations: unknown[] }).installations, []);

	// A runner deployed to Render gets its credential at once, so a restart without its disk still connects.
	const deployed = await account('', 'alice', { method: 'POST', body: JSON.stringify({ for: 'deploy' }) });
	assert.equal(deployed.status, 201, await deployed.clone().text());
	const deployPair = (await deployed.json()) as { id: string; token: string; code?: string };
	assert.equal(deployPair.code, undefined);
	assert(!JSON.stringify(await db.prepare('SELECT * FROM runner').all()).includes(deployPair.token));
	const deployKey = newKey();
	const deployArgs = ['runner', '--serve', '--addr=127.0.0.1:0', '--health-addr=127.0.0.1:0'];
	const deployRun = (dataDir: string) => {
		const child = spawn(binary, deployArgs, {
			env: { ...env, MOB_DATA_DIR: dataDir, MOB_STATE_DIR: dataDir, MOB_RUNNER_PAIRING: JSON.stringify({ url: origin, ...deployPair, key: deployKey }) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		children.push(child);
		return child;
	};
	const deployedSession = async () => ((await (await account(`/${deployPair.id}`)).json()) as { session: string | null }).session;
	const cloudRunner = deployRun(join(dir, 'deployed-1'));
	await until(async () => Boolean(await deployedSession()), 'deployed runner online');
	assert.equal((await encryptedFetch(deployPair.id, deployKey)(`${origin}/api/runners/${deployPair.id}/api/config`)).status, 200);
	// A restart on an empty disk connects again from the variable alone.
	const firstSession = await deployedSession();
	cloudRunner.kill();
	await once(cloudRunner, 'exit');
	deployRun(join(dir, 'deployed-2'));
	await until(async () => {
		const next = await deployedSession();
		return Boolean(next && next !== firstSession);
	}, 'deployed runner back online on an empty disk');

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
		'Runner integration passed: account isolation, passkey binding, one-time pairing, Go/browser encrypted chat, local-only boundaries, replay/reconnect, GitHub App events and revocation.',
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
