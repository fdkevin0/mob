import { cloudflareReady, configured, createAuth, type Env } from './auth';
import { cloudflareAI, cloudflareBase } from './ai';
import { accountRunners, runnerTransport } from './runners';
export { RunnerRelay } from './relay';

// Every page runs one inline script, which applies the colour scheme before
// the first paint (app.html, account.html, landing.html, demo.html, prototype.html).
const themeScript = "'sha256-S6W4VqyCb8qKkLG/FDCsAHhGN7IBdaOVQRlaEQyTHX0='";

// The landing page talks to this Worker (sign-in) and Turnstile.
const landingPolicy = [
	"default-src 'self'",
	`script-src 'self' ${themeScript} https://challenges.cloudflare.com`,
	'frame-src https://challenges.cloudflare.com',
	"connect-src 'self'",
	"img-src 'self' data: https:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ');

// The demo page replays recorded runs; it needs only its own files, plus the
// signed-in visitor's avatar (an HTTPS URL from GitHub or Cloudflare) in the
// shared header.
const demoPolicy = [
	"default-src 'self'",
	`script-src 'self' ${themeScript}`,
	"connect-src 'self'",
	"img-src 'self' data: https:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ');

// The prototypes the documentation embeds (prototype.html) run on sample
// data, and only the documentation, on this origin, may frame them.
const prototypePolicy = [
	"default-src 'self'",
	`script-src 'self' ${themeScript}`,
	"connect-src 'self'",
	"img-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join('; ');

// The account page talks only to this Worker's auth API.
const accountPolicy = [
	"default-src 'self'",
	`script-src 'self' ${themeScript}`,
	"connect-src 'self'",
	"img-src 'self' data: https:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ');

// The app reaches loopback Mob or its own encrypted runner relay.
const appPolicy = [
	"default-src 'self'",
	`script-src 'self' ${themeScript}`,
	"connect-src 'self' http://127.0.0.1:* http://localhost:*",
	"img-src 'self' data: blob: https:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ');

// The browser runner (packages/app/src/browser) is a worker with its own
// policy: it compiles sqlite-wasm and calls model providers, which may be
// anywhere, while the app page that holds the tokens keeps its narrow connect-src.
const runnerPolicy = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
].join('; ');

// The documentation (apps/docs) is public and runs no third-party code: it
// shares an origin with /app, whose local storage holds Mob access tokens.
// The build puts a <meta> policy at the top of every page's <head> (and fails
// without one) that narrows scripts and styles to what it hashed; this header
// covers the other directives and framing.
const docsPolicy = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"connect-src 'self'",
	"img-src 'self' data: https:",
	"font-src 'self' data:",
	"worker-src 'self'",
	"frame-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ');

// Hovering a link to another public page prerenders it (in browsers that
// support speculation rules), so the click shows it at once instead of a full
// reload. /app and /account answer per visitor and connect on load, and links
// with a query (sign-in, docs search) change what the page does, so neither is
// prerendered. Every page names these rules in a Speculation-Rules header.
const speculationRules = JSON.stringify({
	prerender: [{
		where: { or: ['/', '/demo', '/docs/*'].map(pathname => ({ href_matches: { pathname, search: '' } })) },
		eagerness: 'moderate',
	}],
});

// Other files under /docs/media/ (images copied from the repository) are never
// pages, so an SVG opened directly runs nothing.
const docsFilePolicy = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		// Auth answers are per visitor: an edge or browser cache must never keep
		// one, or a page shows another moment's (or another person's) account.
		if (pathname.startsWith('/api/auth/')) return privateResponse(await createAuth(env, url.origin).handler(request));
		if (pathname === '/api/runners' || pathname.startsWith('/api/runners/')) {
			const transport = await runnerTransport(request, env);
			if (transport) return transport;
			const session = await createAuth(env, url.origin).api.getSession({ headers: request.headers });
			if (!session) return new Response('Sign in again', { status: 401 });
			return accountRunners(request, env, session.user.id);
		}
		if (pathname === '/api/site') {
			return Response.json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '', ready: configured(env), cloudflare: cloudflareReady(env) }, { headers: { 'Cache-Control': 'no-store' } });
		}
		if (pathname.startsWith(cloudflareBase + '/')) return cloudflareAI(request, env);
		if (pathname === '/speculation-rules.json') {
			return new Response(speculationRules, { headers: { 'Content-Type': 'application/speculationrules+json', 'Cache-Control': 'public, max-age=3600' } });
		}
		if (pathname === '/') return page(env, request, '/landing', landingPolicy);
		if (pathname === '/demo' || pathname === '/demo/') return page(env, request, '/demo', demoPolicy);
		if (pathname === '/prototype/plan' || pathname === '/prototype/plan/') return page(env, request, '/prototype', prototypePolicy);
		if (pathname === '/app' || pathname === '/app/') {
			const session = await createAuth(env, url.origin).api.getSession({ headers: request.headers });
			// The browser keeps a #offer= fragment across the redirect, and the
			// landing page carries it into the app after sign-in.
			if (!session) return Response.redirect(`${url.origin}/?signin=app`, 302);
			return page(env, request, '/app', appPolicy, 'private, no-store');
		}
		if (pathname === '/account' || pathname === '/account/') {
			const session = await createAuth(env, url.origin).api.getSession({ headers: request.headers });
			if (!session) return Response.redirect(`${url.origin}/?signin=account`, 302);
			return page(env, request, '/account', accountPolicy, 'private, no-store');
		}
		if (pathname.startsWith('/assets/')) return env.ASSETS.fetch(request);
		if (pathname.startsWith('/runner/')) return runnerScript(env, request);
		if (pathname === '/docs') return Response.redirect(`${url.origin}/docs/`, 301);
		if (pathname.startsWith('/docs/')) return docs(env, request);
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function docs(env: Env, request: Request) {
	let asset = await env.ASSETS.fetch(request);
	let status = asset.status;
	if (status === 404) {
		asset = await env.ASSETS.fetch(new Request(new URL('/docs/404.html', request.url), { headers: request.headers }));
		status = 404;
	}
	const response = new Response(asset.body, { status, headers: asset.headers });
	const html = response.headers.get('Content-Type')?.startsWith('text/html') || response.status >= 300 && response.status < 400;
	response.headers.set('Content-Security-Policy', html ? docsPolicy : docsFilePolicy);
	if (html) response.headers.set('Speculation-Rules', '"/speculation-rules.json"');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	return response;
}

async function runnerScript(env: Env, request: Request) {
	const asset = await env.ASSETS.fetch(request);
	const response = new Response(asset.body, asset);
	if (asset.ok) response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	response.headers.set('Content-Security-Policy', runnerPolicy);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	return response;
}

function privateResponse(response: Response) {
	// A redirect from the OAuth flow can be immutable, so copy before setting headers.
	const out = new Response(response.body, response);
	out.headers.set('Cache-Control', 'private, no-store');
	return out;
}

async function page(env: Env, request: Request, path: string, policy: string, cache = 'no-cache') {
	const asset = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: request.headers }));
	const response = new Response(asset.body, asset);
	response.headers.set('Content-Security-Policy', policy);
	response.headers.set('Speculation-Rules', '"/speculation-rules.json"');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Cache-Control', cache);
	return response;
}
