// The models.dev catalog: what models can do. The host reads and refreshes
// the file; the catalog describes models and never decides which ones a
// provider serves.
import type { Info } from '../llm/llm';

export const catalogURL = 'https://models.dev/api.json';

type CatalogModel = {
	id?: string; name?: string; release_date?: string; reasoning?: boolean; tool_call?: boolean; attachment?: boolean;
	reasoning_options?: { type: string; values: string[] }[];
	modalities?: { input?: string[]; output?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; input?: number; output?: number };
};
type CatalogProvider = { name?: string; models?: Record<string, CatalogModel> };
export type CatalogData = Record<string, CatalogProvider>;

/** chat reports whether the model answers in text: image and embedding models are kept out of every list. */
const chat = (m: CatalogModel) => !m.modalities?.output?.length || m.modalities.output.includes('text');

function info(m: CatalogModel, id: string): Info {
	const i: Info = { id, name: m.name ?? '', output: m.limit?.output ?? 0, reasoning: !!m.reasoning, tools: !!m.tool_call, known: true, vision: !!m.modalities?.input?.includes('image') };
	// The input limit, where given, is what a prompt may hold of the window.
	i.context = m.limit?.context ?? 0;
	const input = m.limit?.input ?? 0;
	if (input > 0 && (i.context === 0 || input < i.context)) i.context = input;
	for (const o of m.reasoning_options ?? []) if (o.type === 'effort') i.efforts = o.values;
	if (m.cost) i.cost = { input: m.cost.input ?? 0, output: m.cost.output ?? 0, cacheRead: m.cost.cache_read ?? 0, cacheWrite: m.cost.cache_write ?? 0 };
	return i;
}

/** bare drops a routing prefix: a gateway's "deepseek/deepseek-chat" is deepseek-chat. */
const bare = (id: string) => id.slice(id.lastIndexOf('/') + 1).toLowerCase();

/** vote describes each bare model id as most of the providers serving it do, for providers the catalog does not know. */
function vote(data: CatalogData): Map<string, Info> {
	type Tally = { first: Info; reasoning: number; tools: number; vision: number; contexts: Map<number, number>; outputs: Map<number, number> };
	const tallies = new Map<string, Tally>();
	for (const pid of Object.keys(data).sort()) {
		for (const [id, m] of Object.entries(data[pid].models ?? {})) {
			if (!chat(m)) continue;
			const key = bare(id);
			const i = info(m, key);
			let t = tallies.get(key);
			if (!t) { t = { first: i, reasoning: 0, tools: 0, vision: 0, contexts: new Map(), outputs: new Map() }; tallies.set(key, t); }
			if (!t.first.name) t.first.name = i.name;
			if (!t.first.efforts?.length) t.first.efforts = i.efforts;
			t.reasoning += i.reasoning ? 1 : -1;
			t.tools += i.tools ? 1 : -1;
			t.vision += i.vision ? 1 : -1;
			if (i.context) t.contexts.set(i.context, (t.contexts.get(i.context) ?? 0) + 1);
			if (i.output) t.outputs.set(i.output, (t.outputs.get(i.output) ?? 0) + 1);
		}
	}
	const most = (counts: Map<number, number>) => {
		let best = 0, n = 0;
		for (const [v, c] of counts) if (c > n || (c === n && v < best)) { best = v; n = c; }
		return best;
	};
	const out = new Map<string, Info>();
	for (const [id, t] of tallies) {
		// A relay's price is no maker's list price.
		out.set(id, { ...t.first, reasoning: t.reasoning > 0, tools: t.tools > 0, vision: t.vision > 0, context: most(t.contexts), output: most(t.outputs), cost: undefined });
	}
	return out;
}

export class Catalog {
	private data: CatalogData = {};
	private byID = new Map<string, Info>();

	/** load reads a catalog source: called again whenever the host has a fresher copy. */
	constructor(private source: () => CatalogData | undefined = () => undefined) {}
	private loaded = false;

	private load() {
		if (this.loaded) return;
		this.loaded = true;
		const data = this.source();
		if (data && Object.keys(data).length) { this.data = data; this.byID = vote(data); }
	}

	/** reload makes the next lookup read the source again. */
	reload() { this.loaded = false; }

	/** lookup describes a model: the provider's own entry first, then the bare id across providers. */
	lookup(providerID: string, modelID: string): [Info, boolean] {
		this.load();
		const m = providerID ? this.data[providerID]?.models?.[modelID] : undefined;
		if (m) return [info(m, modelID), true];
		const i = this.byID.get(bare(modelID));
		if (i) return [{ ...i, id: modelID }, true];
		return [{ id: modelID, tools: false, known: false }, false];
	}

	/** models lists one catalog provider's chat models, newest first. */
	models(providerID: string): Info[] {
		this.load();
		const models = this.data[providerID]?.models ?? {};
		const ids = Object.keys(models).filter(id => chat(models[id]));
		ids.sort((a, b) => (models[b].release_date ?? '').localeCompare(models[a].release_date ?? '') || (a < b ? -1 : a > b ? 1 : 0));
		return ids.map(id => info(models[id], id));
	}
}
