/**
 * Pure inbound-authentication (SPF/DKIM/DMARC) helpers for the **Email** feature.
 *
 * Cloudflare Email Routing prepends an `Authentication-Results` header (from
 * `mx.cloudflare.net`) carrying the SPF/DKIM/DMARC verdicts, e.g.
 *   `mx.cloudflare.net; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass`
 * There is no structured runtime API — the verdicts are read from that header.
 *
 * Cloudflare already hard-rejects mail that fails authentication per the
 * sender's DMARC policy, so this is a *stricter local spam bar*: it flags mail
 * that slipped through (e.g. `spf=fail` on a lenient DMARC) so the triage DM is
 * suppressed and the Mini App marks it SPAM. No runtime deps — unit-tested offline.
 */

export interface EmailAuthVerdict {
	/** True → treat as spam: skip the Telegram DM, mark it in the Mini App. */
	spam: boolean;
	/** The raw `Authentication-Results` value (or `''` if absent), stored for display. */
	authResults: string;
	/** Parsed per-mechanism verdicts, lowercased; `null` when the token was absent. */
	spf: string | null;
	dkim: string | null;
	dmarc: string | null;
}

/** Per-mechanism verdicts parsed from an `Authentication-Results` value. */
export interface ParsedAuthResults {
	spf: string | null;
	dkim: string | null;
	dmarc: string | null;
}

/** Read a `method=result` verdict token (e.g. `spf=pass`) from the header value. */
function readMethod(header: string, method: string): string | null {
	const match = header.match(new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, 'i'));
	return match ? match[1].toLowerCase() : null;
}

/**
 * Parse the per-mechanism verdicts out of a stored `Authentication-Results`
 * string — the render-side seam (the Mini App detail screen shows these), the
 * mirror of `evaluateEmailAuth`'s header read. Empty input → all `null`.
 */
export function parseAuthResults(authResults: string | null | undefined): ParsedAuthResults {
	if (!authResults) return { spf: null, dkim: null, dmarc: null };
	return {
		spf: readMethod(authResults, 'spf'),
		dkim: readMethod(authResults, 'dkim'),
		dmarc: readMethod(authResults, 'dmarc'),
	};
}

/**
 * Evaluate an inbound message's authentication from its `Headers`.
 *
 * Spam bar (Q6): `dmarc=fail`, OR (SPF not `pass` AND DKIM not `pass`), OR the
 * `Authentication-Results` header is missing entirely (Cloudflare should always
 * add it — its absence means the message did not pass through the expected MTA
 * and is treated as unauthenticated).
 */
export function evaluateEmailAuth(headers: Headers): EmailAuthVerdict {
	const authResults = headers.get('authentication-results');
	if (!authResults) {
		return { spam: true, authResults: '', spf: null, dkim: null, dmarc: null };
	}

	const { spf, dkim, dmarc } = parseAuthResults(authResults);

	const spam = dmarc === 'fail' || (spf !== 'pass' && dkim !== 'pass');

	return { spam, authResults, spf, dkim, dmarc };
}
