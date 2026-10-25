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
		for (const [name, type] of [['logo.png', 'image/png'], ['logo.svg', 'image/svg+xml'], ['og.png', 'image/png']]) {
			const response = await request('/' + name);
			assert.equal(response.status, 200, name);
			assert.equal(response.headers.get('Content-Type'), type);
			assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile('webapp/public/' + name));
		}
		for (const path of ['/', '/demo', '/docs/']) {
			const response = await request(path);
			assert.equal(response.status, 200, `${path}: ${response.ok ? '' : await response.text()}`);
			assert.match(response.headers.get('Content-Type') ?? '', /^text\/html/);
			const policy = response.headers.get('Content-Security-Policy') ?? '';
			assert.match(policy, /frame-ancestors 'none'/);
			// The shared header shows the signed-in visitor's avatar from its HTTPS host.
			assert.match(policy, /img-src [^;]*https:/, path);
			assert.equal(response.headers.get('Speculation-Rules'), '"/speculation-rules.json"', path);
		}
		const rules = await request('/speculation-rules.json');
		assert.equal(rules.headers.get('Content-Type'), 'application/speculationrules+json');
		// Only the static public pages are prerendered, never a link with a query.
		assert.deepEqual((await rules.json()).prerender[0].where.or.map((rule: { href_matches: unknown }) => rule.href_matches), [
			{ pathname: '/', search: '' }, { pathname: '/demo', search: '' }, { pathname: '/docs/*', search: '' },
		]);
		const docs = await (await request('/docs/')).text();
		const navigation = docs.match(/<nav class="site-links"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
		assert.deepEqual([...navigation.matchAll(/href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]), [
			['/', 'Home'], ['/demo', 'Demo'], ['/docs/', 'Docs'], ['https://github.com/fdkevin0/mob', 'GitHub'],
		]);
		assert.match(navigation, /href="\/docs\/" aria-current="page"/);
		let headerSearches = 0;
		await new HTMLRewriter().on('.site-header > .site-header-inner > .docs-search > site-search', {
			element() { headerSearches++; },
		}).transform(new Response(docs)).text();
		assert.equal(headerSearches, 1, 'Docs search belongs inside the shared header');
		assert.match(docs, /id="site-user"/);
		assert.match(docs, /href="\/\?signin=account">Log in<\/a>/);
		assert.match(docs, /class="site-open" href="\/app">Open Mob<\/a>/);
		for (const path of ['/app', '/app/', '/account', '/account/']) {
			const response = await request(path);
			assert.equal(response.status, 302, path);
			assert.equal(response.headers.get('Location'), origin + '/?signin=' + path.split('/')[1]);
		}
		// Auth answers belong to one visitor, so no cache may keep them.
		for (const path of ['/api/auth/get-session', '/api/auth/list-accounts']) {
			const response = await request(path);
			assert.equal(response.headers.get('Cache-Control'), 'private, no-store', path);
		}
		// Provider tokens stay on the server: the routes that hand them out are off.
		for (const path of ['/api/auth/get-access-token', '/api/auth/refresh-token']) {
			const response = await fetch(origin + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ providerId: 'cloudflare' }) });
			assert.equal(response.status, 404, path);
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
