// The Cloudflare services Mob reaches with the owner's account: Workers AI,
// Vectorize, D1, KV and R2.
export type Config = {
	enabled: boolean; accountId: string; token?: string; hasToken?: boolean; model: string; embeddingModel: string;
	index: string; databaseId: string; namespaceId: string; bucket: string; accessKey?: string; secretKey?: string; hasSecretKey?: boolean;
};

export const defaults = (): Config => ({ enabled: false, accountId: '', token: '', model: '', embeddingModel: '', index: '', databaseId: '', namespaceId: '', bucket: '', accessKey: '', secretKey: '' });

const accountId = /^[a-fA-F0-9]{32}$/, resource = /^[a-zA-Z0-9_@.:-]+$/;

export function validate(c: Config) {
	if (!c.enabled) return;
	if (!accountId.test(c.accountId) || !c.token || /[ \r\n\t]/.test(c.token)) throw new Error('Cloudflare: valid account ID and API token required');
	for (const id of [c.index, c.databaseId, c.namespaceId, c.bucket]) if (id && (!resource.test(id) || id === '.' || id === '..')) throw new Error('Cloudflare: invalid resource name or ID');
}

export function publicView(c: Config): Config {
	const p: Config = { ...c, hasToken: !!c.token, hasSecretKey: !!c.secretKey };
	delete p.token; delete p.secretKey;
	return p;
}

export type Action = { operation: string; text?: string; key?: string; cursor?: string; sql?: string; params?: unknown[] };

const lists: Record<string, string> = { 'ai.models': '/ai/models/search', 'vectorize.indexes': '/vectorize/v2/indexes', 'd1.databases': '/d1/database', 'kv.namespaces': '/storage/kv/namespaces', 'r2.buckets': '/r2/buckets' };

const validModel = (m: string) => m.startsWith('@') && !m.includes('..') && !/[?#%\\ \r\n]/.test(m);

export class Cloudflare {
	constructor(readonly c: Config, readonly fetcher: typeof fetch = fetch) {}

	private base() { return 'https://api.cloudflare.com/client/v4/accounts/' + this.c.accountId; }

	private async request(method: string, path: string, body: unknown, raw: boolean, signal?: AbortSignal): Promise<unknown> {
		let res: Response;
		try {
			res = await this.fetcher(this.base() + path, { method, headers: { Authorization: 'Bearer ' + this.c.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.any([...signal ? [signal] : [], AbortSignal.timeout(30_000)]) });
		} catch { throw new Error('Cloudflare connection failed'); }
		if (res.status < 200 || res.status >= 300) throw new Error(`Cloudflare HTTP ${res.status}; check token permissions and resource IDs`);
		const data = await res.text().catch(() => { throw new Error('Cloudflare response exceeds 2 MiB or is incomplete'); });
		if (new TextEncoder().encode(data).length > 2 << 20) throw new Error('Cloudflare response exceeds 2 MiB or is incomplete');
		if (raw) return { value: data };
		let envelope: { success?: boolean; result?: unknown };
		try { envelope = JSON.parse(data); } catch { envelope = {}; }
		if (!envelope.success) throw new Error('Cloudflare returned an unsuccessful response');
		return envelope.result ?? null;
	}

	/** test verifies the token; account-owned and user-owned tokens have different verification endpoints. */
	async test(signal?: AbortSignal): Promise<unknown> {
		try {
			const result = await this.request('GET', '/tokens/verify', undefined, false, signal) as { status?: string };
			if (result?.status !== 'active') throw Object.assign(new Error('Cloudflare token is inactive'), { final: true });
			return result;
		} catch (err) {
			if ((err as { final?: boolean }).final) throw err;
		}
		let data: { success?: boolean; result?: { status?: string } };
		try {
			const res = await this.fetcher('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: 'Bearer ' + this.c.token }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
			data = JSON.parse((await res.text()).slice(0, 65536));
		} catch { throw new Error('Cloudflare token verification failed'); }
		if (!data.success || data.result?.status !== 'active') throw new Error('Cloudflare token is invalid or inactive');
		return data.result;
	}

	private ready() {
		if (!this.c.enabled) throw new Error('Cloudflare is disabled');
		validate(this.c);
	}

	/** do runs one operation of the web UI's Cloudflare panel, /cloud and the tool. */
	async do(a: Action, signal?: AbortSignal): Promise<unknown> {
		const c = this.c;
		const list = lists[a.operation];
		if (list) { this.ready(); return this.request('GET', list, undefined, false, signal); }
		switch (a.operation) {
			case 'test': this.ready(); return this.test(signal);
			case 'ai.run':
				this.ready();
				if (!validModel(c.model) || !a.text) throw new Error('configure a Workers AI model and enter a prompt');
				return this.request('POST', '/ai/run/' + c.model, { messages: [{ role: 'user', content: a.text }] }, false, signal);
			case 'vectorize.query': {
				this.ready();
				if (!c.index || !validModel(c.embeddingModel) || !a.text) throw new Error('configure an index and embedding model, then enter search text');
				const embed = await this.request('POST', '/ai/run/' + c.embeddingModel, { text: [a.text] }, false, signal) as { data?: number[][] };
				if (!Array.isArray(embed?.data) || embed.data.length !== 1) throw new Error('embedding model returned an unexpected shape');
				return this.request('POST', `/vectorize/v2/indexes/${encodeURIComponent(c.index)}/query`, { vector: embed.data[0], topK: 5, returnMetadata: 'all' }, false, signal);
			}
			case 'd1.query':
				this.ready();
				if (!c.databaseId || !a.sql?.trim()) throw new Error('configure a D1 database and enter SQL');
				return this.request('POST', `/d1/database/${c.databaseId}/query`, { sql: a.sql, params: a.params ?? null }, false, signal);
			case 'kv.get':
				this.ready();
				if (!c.namespaceId || !a.key || a.key === '.' || a.key === '..') throw new Error('configure a KV namespace and enter a key');
				return this.request('GET', `/storage/kv/namespaces/${c.namespaceId}/values/${encodeURIComponent(a.key)}`, undefined, true, signal);
			case 'r2.list': {
				const page = await this.objects().list({ maxKeys: 100, ...a.cursor ? { continuationToken: a.cursor } : {} }).catch(() => { throw new Error('R2 list failed; check S3 credentials and bucket'); });
				return { objects: page.contents ?? [], cursor: page.nextContinuationToken ?? null };
			}
			case 'r2.get': {
				if (!a.key) throw new Error('enter an object key');
				const file = this.objects().file(a.key);
				try {
					const [preview, stat] = await Promise.all([file.slice(0, 1 << 20).text(), file.stat()]);
					return { preview, contentType: stat.type || null, range: stat.size > 1 << 20 ? `bytes 0-${(1 << 20) - 1}/${stat.size}` : null };
				} catch { throw new Error('R2 read failed; check object key and credentials'); }
			}
		}
		throw new Error('unknown Cloudflare operation');
	}

	private objects() {
		this.ready();
		const c = this.c;
		if (!c.bucket || !c.accessKey || !c.secretKey) throw new Error('R2 object access requires bucket, S3 Access Key ID and Secret Access Key');
		return new Bun.S3Client({ accessKeyId: c.accessKey, secretAccessKey: c.secretKey, bucket: c.bucket, region: 'auto', endpoint: `https://${c.accountId}.r2.cloudflarestorage.com` });
	}
}
