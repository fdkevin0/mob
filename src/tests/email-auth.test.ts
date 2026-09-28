import { describe, it, expect } from 'vitest';
import { evaluateEmailAuth, parseAuthResults } from '../features/email/auth';

function headersWith(authResults: string | null): Headers {
	const h = new Headers();
	if (authResults !== null) h.set('authentication-results', authResults);
	return h;
}

/**
 * Pins the inbound SPF/DKIM/DMARC spam bar (Q6): dmarc=fail, OR both SPF and
 * DKIM not pass, OR the Authentication-Results header missing entirely.
 */
describe('evaluateEmailAuth', () => {
	it('fully authenticated mail is not spam', () => {
		const v = evaluateEmailAuth(headersWith('mx.cloudflare.net; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass'));
		expect(v.spam).toBe(false);
		expect(`${v.spf}/${v.dkim}/${v.dmarc}`).toBe('pass/pass/pass');
	});

	it('tolerates a broken SPF when DKIM still passes (the forwarder case)', () => {
		const v = evaluateEmailAuth(headersWith('mx.cloudflare.net; spf=fail; dkim=pass header.d=x; dmarc=pass'));
		expect(v.spam).toBe(false);
	});

	it('flags dmarc=fail as spam even if spf/dkim pass', () => {
		const v = evaluateEmailAuth(headersWith('mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail'));
		expect(v.spam).toBe(true);
	});

	it('flags spam when neither SPF nor DKIM pass', () => {
		const v = evaluateEmailAuth(headersWith('mx.cloudflare.net; spf=softfail; dkim=none'));
		expect(v.spam).toBe(true);
	});

	it('treats a missing Authentication-Results header as unauthenticated spam', () => {
		const v = evaluateEmailAuth(headersWith(null));
		expect(v.spam).toBe(true);
		expect(v.authResults).toBe('');
	});
});

describe('parseAuthResults', () => {
	it('empty header parses to all null', () => {
		const none = parseAuthResults(null);
		expect(`${none.spf}/${none.dkim}/${none.dmarc}`).toBe('null/null/null');
	});

	it('present tokens parsed; absent stays null', () => {
		const some = parseAuthResults('x; spf=pass; dmarc=quarantine');
		expect(some.spf).toBe('pass');
		expect(some.dmarc).toBe('quarantine');
		expect(some.dkim).toBeNull();
	});
});