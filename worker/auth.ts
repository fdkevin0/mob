import { betterAuth } from 'better-auth';
import { captcha } from 'better-auth/plugins/captcha';

export interface Env {
	ASSETS: Fetcher;
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	TURNSTILE_SITE_KEY: string;
	TURNSTILE_SECRET_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
}

export function configured(env: Env) {
	return Boolean(env.BETTER_AUTH_SECRET && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

// One auth instance per request: the origin decides the base URL, so preview
// deployments on workers.dev sign in against themselves.
export function createAuth(env: Env, origin: string) {
	return betterAuth({
		baseURL: origin,
		basePath: '/api/auth',
		secret: env.BETTER_AUTH_SECRET,
		trustedOrigins: [origin],
		database: env.DB,
		// GitHub is the only way in: no passwords to keep.
		socialProviders: {
			github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
		},
		advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
		telemetry: { enabled: false },
		plugins: [captcha({
			provider: 'cloudflare-turnstile',
			secretKey: env.TURNSTILE_SECRET_KEY,
			// Turnstile guards the start of the GitHub flow.
			endpoints: ['/sign-in/social'],
			// Turnstile's test keys report another hostname, so local runs skip the check.
			allowedHostnames: isLocal(origin) ? undefined : [new URL(origin).hostname],
		})],
	});
}

function isLocal(origin: string) {
	const { hostname } = new URL(origin);
	return hostname === 'localhost' || hostname === '127.0.0.1';
}
