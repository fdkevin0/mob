import { configured, createAuth, type Env } from './auth';
import { accountRunners, runnerTransport } from './runners';
export { RunnerRelay } from './relay';

// The landing page talks to this Worker (sign-in) and Turnstile.
const landingPolicy = [
	"default-src 'self'",
	"script-src 'self' https://challenges.cloudflare.com",
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

// The account page talks only to this Worker's auth API.
const accountPolicy = [
	"default-src 'self'",
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
	"connect-src 'self' http://127.0.0.1:* http://localhost:*",
	"img-src 'self' data: blob: https:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
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
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ');

// Other files under /docs/media/ (images copied from the repository) are never
// pages, so an SVG opened directly runs nothing.
const docsFilePolicy = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		if (pathname.startsWith('/api/auth/')) return createAuth(env, url.origin).handler(request);
		if (pathname === '/api/runners' || pathname.startsWith('/api/runners/')) {
			const transport = await runnerTransport(request, env);
			if (transport) return transport;
			const session = await createAuth(env, url.origin).api.getSession({ headers: request.headers });
			if (!session) return new Response('Sign in again', { status: 401 });
			return accountRunners(request, env, session.user.id);
		}
		if (pathname === '/api/site') {
			return Response.json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '', ready: configured(env) }, { headers: { 'Cache-Control': 'no-store' } });
		}
		if (pathname === '/') return page(env, request, '/landing', landingPolicy);
		if (pathname === '/app' || pathname === '/app/') {
			const session = await createAuth(env, url.origin).api.getSession({ headers: request.headers });
			// The browser keeps a #offer= fragment across the redirect, and the
			// landing page carries it into the app after sign-in.
			if (!session) return Response.redirect(`${url.origin}/?signin=app`, 302);
			return page(env, request, '/', appPolicy, 'private, no-store');
		}
		if (pathname === '/account' || pathname === '/account/') {
			const session = await createAuth(env, url.origin).api.getSession({ headers: request.headers });
			if (!session) return Response.redirect(`${url.origin}/?signin=account`, 302);
			return page(env, request, '/account', accountPolicy, 'private, no-store');
		}
		if (pathname.startsWith('/assets/')) return env.ASSETS.fetch(request);
		if (pathname === '/docs') return Response.redirect(`${url.origin}/docs/`, 301);
		if (pathname.startsWith('/docs/')) return docs(env, request);
		return Response.redirect(`${url.origin}/`, 302);
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
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	return response;
}

async function page(env: Env, request: Request, path: string, policy: string, cache = 'no-cache') {
	const asset = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: request.headers }));
	const response = new Response(asset.body, asset);
	response.headers.set('Content-Security-Policy', policy);
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Cache-Control', cache);
	return response;
}
