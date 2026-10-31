// The Mob GitHub App's checks that need no Worker bindings: webhook
// signatures, what of a webhook a runner hears, and the app's own JWT. Web
// Crypto only, so they run in the Worker and in tests alike.
import { repoName, type GitHubEvent } from '@mob/core/github';

/** events are the webhooks a runner hears, each with the actions it acts on. */
const events: Record<string, string[]> = {
	issues: ['opened', 'labeled', 'unlabeled', 'closed', 'reopened'],
	issue_comment: ['created'],
	pull_request: ['opened', 'synchronize', 'ready_for_review', 'closed', 'reopened'],
	pull_request_review: ['submitted'],
	pull_request_review_comment: ['created'],
	check_suite: ['completed'],
};

/** permissions a runner may ask a token for, and the most each may be. */
export const grantable: Record<string, 'read' | 'write'> = {
	contents: 'write',
	issues: 'write',
	pull_requests: 'write',
	checks: 'read',
	actions: 'read',
	statuses: 'read',
	metadata: 'read',
};

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

/** verify checks GitHub's X-Hub-Signature-256 for body, in constant time. */
export async function verify(secret: string, body: string, signature: string | null): Promise<boolean> {
	if (!secret || !signature?.startsWith('sha256=')) return false;
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const want = 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
	if (want.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
}

export type Payload = Record<string, any>;
export const str = (v: unknown) => (typeof v === 'string' ? v : '');
export const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : undefined);

/** mentions says text names the app as @slug, as a whole word. */
export function mentions(text: unknown, slug: string): boolean {
	if (typeof text !== 'string' || !slug) return false;
	const at = new RegExp(`(^|[^\\w@/-])@${slug.replace(/[^\w-]/g, '')}(?![\\w-])`, 'i');
	return at.test(text);
}

/**
 * metadata keeps what routes webhook p: the event, the repository and item,
 * who did it, and whether a comment names the app. undefined for events the
 * runner does not act on.
 */
export function metadata(event: string, delivery: string, p: Payload, slug: string, now = Date.now()): GitHubEvent | undefined {
	const action = str(p.action);
	if (!events[event]?.includes(action)) return;
	const installation = int(p.installation?.id);
	const repo = str(p.repository?.full_name);
	const sender = p.sender;
	if (!installation || !repoName.test(repo) || !sender || !int(sender.id)) return;
	const out: GitHubEvent = {
		delivery, event, action, installation, repo,
		sender: { login: str(sender.login), id: sender.id, bot: sender.type === 'Bot' || str(sender.login).endsWith('[bot]') },
		at: now,
	};
	const item = p.pull_request ?? p.issue;
	if (item) {
		out.number = int(item.number);
		out.pull = !!p.pull_request || !!p.issue?.pull_request;
		out.association = str(item.author_association) || undefined;
	}
	if (event === 'issues' && action === 'opened') out.mention = mentions(p.issue?.body, slug) || mentions(p.issue?.title, slug);
	if (p.label?.name) out.label = str(p.label.name).slice(0, 100);
	const said = p.comment ?? p.review;
	if (said) {
		out.comment = int(said.id);
		out.association = str(said.author_association) || out.association;
		out.mention = mentions(said.body, slug);
	}
	if (event === 'check_suite') {
		out.conclusion = str(p.check_suite?.conclusion) || undefined;
		out.pulls = (Array.isArray(p.check_suite?.pull_requests) ? p.check_suite.pull_requests : []).map((r: Payload) => int(r.number)).filter((n: unknown): n is number => !!n).slice(0, 20);
	}
	return out;
}

// --- App authentication ---

/** der wraps content in an ASN.1 element of tag. */
function der(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
	const n = content.length;
	const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
	const out = new Uint8Array(1 + len.length + n);
	out[0] = tag;
	out.set(len, 1);
	out.set(content, 1 + len.length);
	return out;
}
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
};

/** pkcs8 reads a PEM private key. GitHub hands out PKCS#1 (BEGIN RSA PRIVATE KEY), which WebCrypto cannot import, so it is wrapped as PKCS#8. */
export function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
	const rsa = pem.includes('BEGIN RSA PRIVATE KEY');
	const body = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
	const raw = Uint8Array.from(atob(body), c => c.charCodeAt(0));
	if (!rsa) return raw;
	const version = new Uint8Array([0x02, 0x01, 0x00]);
	// AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1), NULL parameters.
	const algorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
	return der(0x30, concat(version, algorithm, der(0x04, raw)));
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** appJWT signs the ten-minute JWT that authenticates as the app itself. */
export async function appJWT(appID: string, pem: string, now = Date.now()): Promise<string> {
	const key = await crypto.subtle.importKey('pkcs8', pkcs8(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
	const s = Math.floor(now / 1000);
	const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
	// Issued a minute early, as GitHub advises, against clock drift.
	const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: s - 60, exp: s + 540, iss: appID })}`;
	const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
	return `${unsigned}.${b64url(signature)}`;
}

/** narrow checks the permissions a runner asks for against what Mob grants at most. Workflows is never granted, so no token can change .github/workflows. */
export function narrow(asked: unknown): Record<string, 'read' | 'write'> | string {
	if (!asked || typeof asked !== 'object' || Array.isArray(asked)) return 'permissions must be an object';
	const out: Record<string, 'read' | 'write'> = {};
	for (const [name, level] of Object.entries(asked)) {
		const most = grantable[name];
		if (!most) return `permission ${name} is not granted to runners`;
		if (level !== 'read' && level !== 'write') return `permission ${name} must be read or write`;
		if (level === 'write' && most === 'read') return `permission ${name} is read-only`;
		out[name] = level;
	}
	if (!Object.keys(out).length) return 'ask for at least one permission';
	return out;
}

