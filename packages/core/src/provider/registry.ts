// The provider registry resolves model references against providers.json,
// which stays the only source of truth; the host supplies its storage.
import { AnthropicModel } from '../llm/anthropic';
import { DemoModel, demoID, demoInfo, demoRef } from '../llm/demo';
import { efforts, parseRef, refKey, refString, type Group, type Info, type Model, type Ref } from '../llm/llm';
import { OpenAIModel } from '../llm/openai';
import { secrets, statusError, type Fetch } from '../llm/send';
import type { Models } from '../chat/conversation';
import { Catalog } from './catalog';
import { findPreset, openCodeFree } from './presets';
import { destination, displayName, endpoint, initialProviders, picks, protocolFor, validateProviders, type Provider, type ProvidersFile } from './provider';

/** listFresh is how long a vendor's model list is used before /models asks again. */
const listFresh = 10 * 60_000;

/**
 * ProvidersStorage keeps providers.json. read returns undefined when the file
 * does not exist and throws when it exists but cannot be used; update runs
 * change on the file as it is on disk under a lock other processes respect.
 */
export interface ProvidersStorage {
	read(): ProvidersFile | undefined;
	update(change: (f: ProvidersFile | undefined) => ProvidersFile): ProvidersFile;
}

/** memoryProviders keeps providers.json in memory (tests, the browser until it has storage). */
export function memoryProviders(file?: ProvidersFile): ProvidersStorage {
	return { read: () => file, update: change => (file = change(file)) };
}

/** AmbiguousError lists the models a short name could mean. */
export class AmbiguousError extends Error {
	constructor(readonly query: string, readonly candidates: string[]) {
		super(`"${query}" matches several models: ${candidates.join(', ')}; use the full provider/model name`);
	}
}

type List = { ids: string[]; at: number; error?: string; of: string };

/** fingerprint identifies what a model list depends on, so a provider whose endpoint or key changes is asked again. */
const fingerprint = (p: Provider) => destination(p) + '\x00' + (p.key ?? '') + '\x00' + Object.keys(p.headers ?? {}).sort().map(k => k + '\x00' + p.headers![k]).join('\x00');

/** isFree tells a model that costs nothing to call: priced at zero, or a `:free` variant, which is how OpenRouter names them. */
const isFree = (i: Info) => (i.cost?.input === 0 && i.cost.output === 0) || i.id.endsWith(':free');

/** hidden drops the models Mob must not offer: OpenCode Zen's free tier, which is for OpenCode's own clients. */
const hidden = (p: Provider, ids: string[]) => findPreset(p.preset)?.id === 'opencode' ? ids.filter(id => !openCodeFree(id)) : ids;

/** nonChat are fragments of model IDs that do not converse. */
const nonChat = ['embed', 'whisper', 'tts', 'dall-e', 'image', 'moderation', 'transcribe', 'rerank', 'audio', 'realtime', 'sora'];

export class ProviderRegistry implements Models {
	private file: ProvidersFile;
	private lists = new Map<string, List>();
	/** noTools holds, per provider, the models whose vendor list says they take no tools (OpenRouter's supported_parameters). */
	private noTools = new Map<string, Set<string>>();

	/** demo makes the offline model the default, for MOB_DEMO. */
	// A browser's fetch throws when called as another object's method, so the default calls it on its own.
	constructor(private storage: ProvidersStorage = memoryProviders(), readonly catalog = new Catalog(), public demo = false, private fetcher: Fetch = (input, init) => fetch(input, init)) {
		const f = storage.read();
		if (f) validateProviders(f);
		// A missing file is the initial configuration.
		this.file = f ?? initialProviders();
	}

	/**
	 * reload rereads providers.json; a file that cannot be used, or was
	 * removed, leaves the providers in effect unchanged.
	 */
	reload() {
		const f = this.storage.read();
		if (!f) throw new Error('providers.json was removed');
		validateProviders(f);
		this.file = f;
	}

	providers(): ProvidersFile { return { ...this.file, providers: [...this.file.providers] }; }

	/** update applies change to the file as it is on disk and saves it. */
	update(change: (f: ProvidersFile) => void) {
		this.file = this.storage.update(disk => {
			// A file removed meanwhile is rewritten from the providers in effect.
			const f = structuredClone(disk ?? this.file);
			change(f);
			validateProviders(f);
			return f;
		});
	}

	private find(id: string) { return this.file.providers.find(p => p.id === id); }

	private listOf(p: Provider): Partial<List> {
		const l = this.lists.get(p.id);
		return l && l.of === fingerprint(p) ? l : {};
	}

	default(): string {
		if (this.demo) return refString(demoRef);
		if (this.file.default) return this.file.default;
		for (const p of this.file.providers) {
			const ids = this.available(p);
			if (!p.off && ids.length) return p.id + '/' + ids[0];
		}
		return '';
	}

	setDefault(query: string): Ref {
		const ref = this.resolve(query).ref;
		if (ref.provider === demoID) throw new Error('the demo model cannot be the saved default');
		this.update(f => { f.default = refString(ref); });
		return ref;
	}

	/** available lists a provider's model IDs without asking the vendor: the user's picks, else its last fetched list, else its catalog entry. */
	private available(p: Provider): string[] {
		let ids = picks(p, this.listOf(p).ids ?? []);
		const preset = findPreset(p.preset);
		if (!ids.length && preset?.catalog) ids = this.catalog.models(preset.catalog).map(i => i.id);
		return hidden(p, ids);
	}

	/** info is the catalog's description of a model with the user's overrides; an unknown model is assumed to take tools. */
	info(p: Provider, id: string): Info {
		let [i, known] = this.catalog.lookup(findPreset(p.preset)?.catalog ?? '', id);
		if (!known) i = { id, tools: true, known: false };
		const pref = p.modelPrefs?.[id] ?? {};
		i = { ...i, name: pref.name || i.name };
		if (pref.context && pref.context > 0) i.context = pref.context;
		if (pref.output && pref.output > 0) i.output = pref.output;
		if (pref.reasoning !== undefined) i.reasoning = pref.reasoning;
		if (this.noTools.get(p.id)?.has(id)) i.tools = false;
		if (pref.tools !== undefined) i.tools = pref.tools;
		if (pref.vision !== undefined) i.vision = pref.vision;
		if (pref.efforts?.length) i.efforts = pref.efforts;
		if (pref.cost) i.cost = pref.cost;
		if (isFree(i)) i.free = true; else delete i.free;
		return i;
	}

	private build(p: Provider, ref: Ref): Model {
		const info = this.info(p, ref.model);
		if (ref.effort && ref.effort !== 'none' && info.efforts?.length && !info.efforts.includes(ref.effort)) throw new Error(`${refKey(ref)} takes reasoning levels ${info.efforts.join(', ')}`);
		let key = p.key ?? '';
		const preset = findPreset(p.preset);
		if (!key && preset) {
			if (preset.appKey) key = preset.appKey;
			else if (!preset.noKey) throw new Error(`provider ${p.id} has no API key; run: mob provider add ${p.id} --key-stdin`);
		}
		const proto = protocolFor(p, ref.model);
		const base = endpoint(p, proto);
		if (!base) throw new Error(`provider ${p.id} has no ${proto} base URL`);
		if (proto === 'anthropic') return new AnthropicModel(ref, info, { baseURL: base, key, headers: p.headers, fetch: this.fetcher });
		const quirk = preset?.quirk;
		return new OpenAIModel(ref, info, { baseURL: base, key, headers: p.headers, fetch: this.fetcher, prepare: quirk && ((h, body) => quirk(ref.model, h, body)) });
	}

	/**
	 * resolve finds a model by full reference (provider/model[:effort]), by its
	 * bare ID when one provider has it, or by a fragment of its ID or name when
	 * that is unique. A full reference to a configured provider is accepted even
	 * when the model is not listed.
	 */
	resolve(query: string): Model {
		query = query.trim();
		if (!query) throw new Error('no model given');
		const full = parseRef(query);
		if (full && (full.provider === demoID || this.find(full.provider))) return this.model(full);
		let effort = '';
		const colon = query.lastIndexOf(':');
		if (colon > 0 && efforts.includes(query.slice(colon + 1))) { effort = query.slice(colon + 1); query = query.slice(0, colon); }
		const needle = query.toLowerCase();
		const exact: Ref[] = [], partial: Ref[] = [];
		for (const g of this.groups('')) for (const m of g.models) {
			const ref = { provider: g.provider, model: m.id, effort };
			const id = m.id.toLowerCase();
			if (id === needle || refKey(ref).toLowerCase() === needle) exact.push(ref);
			else if (id.includes(needle) || (m.name ?? '').toLowerCase().includes(needle)) partial.push(ref);
		}
		for (const found of [exact, partial]) {
			if (found.length === 1) return this.model(found[0]);
			if (found.length > 1) throw new AmbiguousError(query, found.slice(0, 10).map(refKey));
		}
		throw new Error(`no model matches "${query}"; /models lists them`);
	}

	private model(ref: Ref): Model {
		if (ref.provider === demoID) return new DemoModel();
		const p = this.find(ref.provider);
		if (!p) throw new Error('no provider ' + ref.provider);
		if (p.off) throw new Error(`provider ${p.id} is switched off`);
		return this.build(p, ref);
	}

	/** groups describes every enabled provider's models from what is known now. */
	groups(query: string): Group[] {
		query = query.trim().toLowerCase();
		const providers: Provider[] = [...(this.demo ? [{ id: demoID, name: demoInfo.name }] : []), ...this.file.providers];
		const out: Group[] = [];
		for (const p of providers) {
			if (p.off) continue;
			const g: Group = { provider: p.id, name: displayName(p), models: p.id === demoID ? [demoInfo] : this.available(p).map(id => this.info(p, id)) };
			const error = this.listOf(p).error;
			if (error) g.error = error;
			if (query && !p.id.includes(query) && !g.name.toLowerCase().includes(query)) {
				g.models = g.models.filter(i => i.id.toLowerCase().includes(query) || (i.name ?? '').toLowerCase().includes(query));
				if (!g.models.length) continue;
			}
			out.push(g);
		}
		return out;
	}

	/** list refreshes vendors' model lists older than ten minutes, then describes every enabled provider's models matching query. */
	async list(query: string, signal?: AbortSignal): Promise<Group[]> {
		await Promise.all(this.file.providers.filter(p => !p.off && Date.now() - (this.listOf(p).at ?? 0) >= listFresh).map(async p => {
			const of = fingerprint(p);
			try {
				this.lists.set(p.id, { ids: await this.fetch(p, signal), at: Date.now(), of });
			} catch (e) {
				// Keep the last good list for the same endpoint.
				this.lists.set(p.id, { ids: this.listOf(p).ids ?? [], at: Date.now(), error: (e as Error).message, of });
			}
		}));
		return this.groups(query);
	}

	/** fetch asks the vendor which models it serves: modelsURL, else /models under the chat base, else Anthropic's /v1/models. */
	async fetch(p: Provider, signal?: AbortSignal): Promise<string[]> {
		let url = p.modelsURL ?? '', anthropicAPI = false;
		if (!url && endpoint(p, 'chat')) url = endpoint(p, 'chat').replace(/\/+$/, '') + '/models';
		else if (!url) { url = endpoint(p, 'anthropic').replace(/\/+$/, '') + '/v1/models?limit=1000'; anthropicAPI = true; }
		const preset = findPreset(p.preset);
		const key = p.key || preset?.appKey || '';
		const headers = new Headers();
		if (key) {
			if (anthropicAPI) { headers.set('x-api-key', key); headers.set('anthropic-version', '2023-06-01'); } else headers.set('Authorization', 'Bearer ' + key);
		}
		for (const [k, v] of Object.entries(p.headers ?? {})) headers.set(k, v);
		const timeout = AbortSignal.timeout(15_000);
		let response: Response;
		try {
			response = await this.fetcher(url, { headers, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		} catch { throw new Error(p.id + ': model list unavailable'); }
		if (response.status !== 200) throw new Error(p.id + ': ' + (await statusError(response, secrets(key, p.headers))).message);
		let body: { data?: { id?: unknown; supported_parameters?: unknown }[] };
		try { body = JSON.parse((await response.text()).slice(0, 4 << 20)); } catch { throw new Error(p.id + ': invalid model list'); }
		const ids: string[] = [], noTools = new Set<string>();
		for (const m of body.data ?? []) {
			const id = typeof m.id === 'string' ? m.id : '';
			const lower = id.toLowerCase();
			if (!id || id.length > 256 || /[\r\n\0 ]/.test(id) || nonChat.some(s => lower.includes(s))) continue;
			if (!ids.includes(id)) ids.push(id);
			if (Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools')) noTools.add(id);
		}
		this.noTools.set(p.id, noTools);
		return hidden(p, ids).sort();
	}
}

