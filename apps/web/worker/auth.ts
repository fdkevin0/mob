import type { RunnerRelay } from './relay';
import { betterAuth } from 'better-auth';
import { captcha } from 'better-auth/plugins/captcha';
import { getAuthenticatorName, passkey } from '@better-auth/passkey';
import { isLoopbackHost } from '@mob/core/url';

export interface Env {
	ASSETS: Fetcher;
	RUNNERS: DurableObjectNamespace<RunnerRelay>;
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	TURNSTILE_SITE_KEY: string;
	TURNSTILE_SECRET_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	/** Cloudflare sign-in is offered once both are set. */
	CLOUDFLARE_CLIENT_ID?: string;
	CLOUDFLARE_CLIENT_SECRET?: string;
	/** CLOUDFLARE_SCOPES are the scope IDs asked for besides user-details.read, space-separated, as the OAuth client lists them. */
	CLOUDFLARE_SCOPES?: string;
}

/** cloudflareReady tells whether Cloudflare can sign in and lend Workers AI. */
export const cloudflareReady = (env: Env) => Boolean(env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET);

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
		// GitHub or Cloudflare creates an account: no passwords to keep.
		// Passkeys are added afterwards from the account page, and Cloudflare
		// can be connected there to an account GitHub created.
		socialProviders: {
			github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
			...(cloudflareReady(env) ? {
				cloudflare: {
					clientId: env.CLOUDFLARE_CLIENT_ID!,
					clientSecret: env.CLOUDFLARE_CLIENT_SECRET!,
					// Workers AI calls need the account and AI scopes; offline_access keeps the token refreshable.
					scope: (env.CLOUDFLARE_SCOPES ?? '').split(/\s+/).filter(Boolean),
				},
			} : {}),
		},
		// Provider tokens never leave the server: the Workers AI proxy reads them
		// through auth.api, which disabled paths do not block.
		disabledPaths: ['/get-access-token', '/refresh-token'],
		account: {
			// Provider tokens are kept encrypted: the Cloudflare one spends the visitor's account.
			encryptOAuthTokens: true,
			// Connecting happens only from a signed-in account page, never by matching emails.
			// Cloudflare never says the email is verified, so connecting it from there must
			// trust it; with implicit linking off, that trust applies to nothing else.
			accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true, trustedProviders: ['github', 'cloudflare'] },
		},
		advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
		telemetry: { enabled: false },
		plugins: [captcha({
			provider: 'cloudflare-turnstile',
			secretKey: env.TURNSTILE_SECRET_KEY,
			// Turnstile guards the start of the GitHub and Cloudflare flows.
			endpoints: ['/sign-in/social'],
			// Turnstile's test keys report another hostname, so local runs skip the check.
			allowedHostnames: isLocal(origin) ? undefined : [new URL(origin).hostname],
		}), passkey({
			rpName: 'Mob',
			// Registration needs a fresh signed-in session, so a passkey always
			// joins an account that already signed in with GitHub.
			registration: {
				requireSession: true,
				// The browser never reveals a device name; the authenticator model
				// (AAGUID) names the provider, such as iCloud Keychain or Windows Hello.
				afterVerification: ({ verification }) => {
					const name = getAuthenticatorName(verification.registrationInfo?.aaguid);
					return name ? { name } : undefined;
				},
			},
		})],
	});
}

function isLocal(origin: string) {
	return isLoopbackHost(new URL(origin).hostname);
}
