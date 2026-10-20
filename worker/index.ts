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
		if (pathname.startsWith('/assets/')) return env.ASSETS.fetch(request);
		return Response.redirect(`${url.origin}/`, 302);
	},
} satisfies ExportedHandler<Env>;

async function page(env: Env, request: Request, path: string, policy: string, cache = 'no-cache') {
	const asset = await env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: request.headers }));
	const response = new Response(asset.body, asset);
	response.headers.set('Content-Security-Policy', policy);
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Cache-Control', cache);
	return response;
}
