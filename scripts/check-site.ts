// Exercise the deployed asset routing offline, using the public build and Wrangler rules.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const config = Bun.JSONC.parse(await readFile('wrangler.jsonc', 'utf8'));
const built = await Bun.build({ entrypoints: [config.main], target: 'browser', external: ['cloudflare:workers', 'node:*'] });
assert(built.success, String(built.logs));
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
	name: config.name,
	modules: true,
	script: await built.outputs[0].text(),
	compatibilityDate: config.compatibility_date,
	compatibilityFlags: config.compatibility_flags,
	assets: { ...config.assets, routerConfig: { has_user_worker: true } },
	d1Databases: { DB: 'site-test' },
	durableObjects: { RUNNERS: { className: 'RunnerRelay', useSQLite: true } },
	bindings: {
		BETTER_AUTH_SECRET: 'offline-test-secret-that-is-at-least-32-characters',
		GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test',
		TURNSTILE_SITE_KEY: 'test', TURNSTILE_SECRET_KEY: 'test',
	},
}] }));
try {
	const origin = (await mf.ready).origin;
	const db = await mf.getD1Database('DB');
	for (const file of (await readdir('worker/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
		const sql = (await readFile(`worker/migrations/${file}`, 'utf8')).replace(/^--.*$/gm, '');
		for (const statement of sql.split(';').filter((s) => s.trim())) await db.prepare(statement).run();
	}
	// Cover both subresource fetches and browser navigations.
	for (const headers of [{}, { 'Sec-Fetch-Mode': 'navigate' }]) {
		const request = (path: string) => fetch(origin + path, { redirect: 'manual', headers });
		for (const name of ['logo.png', 'og.png']) {
			const response = await request('/' + name);
			assert.equal(response.status, 200, name);
			assert.equal(response.headers.get('Content-Type'), 'image/png');
			assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile('webapp/public/' + name));
		}
		for (const path of ['/', '/demo', '/docs/']) {
			const response = await request(path);
			assert.equal(response.status, 200, `${path}: ${response.ok ? '' : await response.text()}`);
			assert.match(response.headers.get('Content-Type') ?? '', /^text\/html/);
			assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
		}
		for (const path of ['/app', '/app/', '/account', '/account/']) {
			const response = await request(path);
			assert.equal(response.status, 302, path);
			assert.equal(response.headers.get('Location'), origin + '/?signin=' + path.split('/')[1]);
		}
		for (const path of ['/missing.png', '/missing-page', '/assets/missing.js', '/docs/missing-page',
			'/index.html', '/account.html', '/landing.html', '/demo.html']) {
			const response = await request(path);
			assert.equal(response.status, 404, path);
			assert.equal(response.headers.get('Location'), null, path);
		}
	}
	console.log('Public site routing passed');
} finally {
	await mf.dispose();
}
