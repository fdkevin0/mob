/** Verify initData carried explicitly on Mini App requests. The initial page GET contains no authenticated user identity. */
import { hashToken, validate } from '@tma.js/init-data-node/web';

const DEFAULT_MAX_AGE_SECONDS = 3600;

/** Cache the derived signing key per bot token within the isolate. */
const hashedTokenCache = new Map<string, Promise<ArrayBuffer>>();

function hashTokenCached(botToken: string): Promise<ArrayBuffer> {
	const cached = hashedTokenCache.get(botToken);
	if (cached) return cached;

	const derived = hashToken(botToken);
	hashedTokenCache.set(botToken, derived);
	return derived;
}

export interface VerifiedInitData {
	userId: number;
}

/** Verify signature, age, and user ID. All failures return null for uniform rejection. */
export async function verifyInitData(
	botToken: string,
	initDataRaw: string,
	maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS
): Promise<VerifiedInitData | null> {
	try {
		// `tokenHashed: true` feeds the cached pre-derived secret straight into the
		// HMAC (see the module doc); `expiresIn` overrides the SDK's 1-day default
		// with the module's original 1-hour staleness bar.
		await validate(initDataRaw, await hashTokenCached(botToken), {
			expiresIn: maxAgeSeconds,
			tokenHashed: true,
		});
	} catch {
		return null;
	}

	const params = new URLSearchParams(initDataRaw);
	const userRaw = params.get('user');
	if (!userRaw) return null;
	try {
		const user = JSON.parse(userRaw) as { id?: unknown };
		if (typeof user.id !== 'number') return null;
		return { userId: user.id };
	} catch {
		return null;
	}
}
