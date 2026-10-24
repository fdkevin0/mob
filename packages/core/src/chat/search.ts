// tool_search: deferred tools and entries such as skills, ranked by BM25.
import type { Tool } from './tools';

/** Exposure is how a tool reaches the model: declared to every turn, once tool_search loads it, or never. */
export type Exposure = 'direct' | 'deferred' | 'hidden';

export function parseExposure(s: string): Exposure {
	if (s === 'direct' || s === 'deferred' || s === 'hidden') return s;
	throw new Error(`exposure "${s}" is not direct, deferred or hidden`);
}

/** Entry is something tool_search finds that is not a tool to load, such as a skill another tool loads by name. */
export type Entry = {
	kind: string;
	name: string;
	description: string;
	/** use tells the model how to use it, such as which tool to call. */
	use: string;
	ownerOnly?: boolean;
};

export const searchName = 'tool_search';
const searchLimit = 5, searchMax = 10, searchDescription = 300;

/** searchPrompt tells the model what tool_search can find. */
export function searchPrompt(waiting: Tool[], entries: Entry[]) {
	const counts = new Map<string, number>();
	for (const t of waiting) { const g = t.namespace || 'other'; counts.set(g, (counts.get(g) ?? 0) + 1); }
	for (const e of entries) { const g = e.kind + 's'; counts.set(g, (counts.get(g) ?? 0) + 1); }
	const parts = [...counts].map(([g, n]) => `${g} (${n})`);
	return 'More tools and skills are available than are declared: ' + parts.join(', ') + '. Before saying you cannot do something, call tool_search with keywords for the task; the tools it finds can be called in your next step.';
}

type Found = { name: string; kind: string; description?: string; namespace?: string; use: string };
/** SearchResult is what tool_search returns. loaded is read back from history to keep the tools loaded in later turns. */
export type SearchResult = { loaded: string[]; results: Found[]; note?: string };

/** toolSearch is the tool_search tool of one turn: it ranks tools not yet declared, and entries, and loads the tools it finds. */
export function toolSearch(waiting: () => Tool[], loaded: () => Tool[], entries: Entry[], load: (tools: Tool[]) => void): Tool {
	return {
		name: searchName,
		description: 'Find tools and skills that are not declared yet by keywords, such as "github issue" or "send email". Tools found are loaded and can be called in the next step; skills found say how to use them.',
		parameters: {
			type: 'object', properties: {
				query: { type: 'string', description: "Keywords for what the task needs, or a tool's exact name" },
				limit: { type: 'integer', minimum: 1, maximum: searchMax, description: `Results to return; default ${searchLimit}` },
			}, required: ['query'], additionalProperties: false,
		},
		run: async call => {
			const query = typeof call.input.query === 'string' ? call.input.query : '';
			if (!query.trim()) throw new Error('query must name what the task needs');
			let limit = searchLimit;
			const n = call.input.limit;
			if (typeof n === 'number' && n >= 1) limit = Math.min(Math.trunc(n), searchMax);
			return search(query, limit, waiting(), loaded(), entries, load);
		},
	};
}

export function search(query: string, limit: number, waiting: Tool[], loaded: Tool[], entries: Entry[], load: (tools: Tool[]) => void): SearchResult {
	type Candidate = { tool?: Tool; entry?: Entry; loaded?: boolean };
	const candidates: Candidate[] = [], docs: Doc[] = [];
	for (const t of waiting) { candidates.push({ tool: t }); docs.push(toolDocument(t)); }
	for (const t of loaded) { candidates.push({ tool: t, loaded: true }); docs.push(toolDocument(t)); }
	for (const e of entries) { candidates.push({ entry: e }); docs.push({ name: e.name, fields: [[e.name, 3], [e.kind, 1], [e.description, 1]] }); }
	const result: SearchResult = { loaded: [], results: [] };
	const toLoad: Tool[] = [];
	for (const i of rank(docs, query, limit)) {
		const c = candidates[i];
		if (c.entry) {
			result.results.push(found({ name: c.entry.name, kind: c.entry.kind, description: brief(c.entry.description), use: c.entry.use }));
			continue;
		}
		const t = c.tool!;
		let use = 'Loaded; call it in your next step.';
		if (c.loaded) use = 'Already loaded; call it.';
		else { toLoad.push(t); result.loaded.push(t.name); }
		result.results.push(found({ name: t.name, kind: 'tool', description: brief(t.description), namespace: t.namespace, use }));
	}
	if (toLoad.length) load(toLoad);
	if (!result.results.length) result.note = 'Nothing matched; try other keywords, such as the service or action the task needs.';
	return result;
}

// found keeps Go's field order and leaves out empty fields.
const found = (f: Found): Found => ({ name: f.name, kind: f.kind, ...(f.description ? { description: f.description } : {}), ...(f.namespace ? { namespace: f.namespace } : {}), use: f.use });

function brief(s: string) {
	s = s.trim();
	const r = [...s];
	return r.length > searchDescription ? r.slice(0, searchDescription).join('') + '…' : s;
}

type Doc = { name: string; fields: [string, number][] };

function toolDocument(t: Tool): Doc {
	const fields: [string, number][] = [[t.name, 3], [t.namespace ?? '', 2], [t.description, 1]];
	const properties = (t.parameters as { properties?: Record<string, { description?: unknown }> }).properties;
	if (properties && typeof properties === 'object') {
		for (const name of Object.keys(properties).sort()) {
			fields.push([name, 1]);
			const d = properties[name]?.description;
			if (typeof d === 'string') fields.push([d, 1]);
		}
	}
	return { name: t.name, fields };
}

/** rank orders documents by BM25 against query and returns the indices of at most limit that match, best first. */
export function rank(docs: Doc[], query: string, limit: number): number[] {
	const k1 = 1.2, b = 0.75;
	const terms = [...new Set(words(query))].sort();
	const counts = docs.map(() => new Map<string, number>());
	const lengths = docs.map(() => 0);
	const frequency = new Map<string, number>();
	let total = 0;
	docs.forEach((d, i) => {
		for (const [text, weight] of d.fields) for (const term of words(text)) {
			counts[i].set(term, (counts[i].get(term) ?? 0) + weight);
			lengths[i] += weight;
		}
		for (const term of counts[i].keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
		total += lengths[i];
	});
	if (!docs.length) return [];
	const average = Math.max(total / docs.length, 1);
	const exact = query.trim();
	const scores = docs.map(() => 0);
	const matched: number[] = [];
	docs.forEach((d, i) => {
		for (const term of terms) {
			const tf = counts[i].get(term) ?? 0;
			if (!tf) continue;
			const n = frequency.get(term) ?? 0;
			const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
			scores[i] += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * lengths[i] / average));
		}
		if (d.name === exact) scores[i] += 1000;
		if (scores[i] > 0) matched.push(i);
	});
	// Array.prototype.sort is stable.
	matched.sort((x, y) => scores[y] - scores[x]);
	return matched.slice(0, limit);
}

const stopwords = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'or', 'is', 'it', 'by', 'from', 'this', 'that', 'be', 'as', 'at', 'mcp', 'tool', 'server']);

/**
 * words splits text into lowercase words at punctuation and underscores, each
 * Han character its own word, without stopwords and with a plural s dropped.
 * A camelCase word also gives its parts.
 */
export function words(text: string): string[] {
	const out: string[] = [];
	const add = (w: string) => {
		w = w.toLowerCase();
		if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
		if (!stopwords.has(w)) out.push(w);
	};
	let word: string[] = [];
	const flush = () => {
		if (!word.length) return;
		add(word.join(''));
		let start = 0;
		for (let i = 1; i < word.length; i++) {
			if (/\p{Lu}/u.test(word[i]) && /\p{Ll}/u.test(word[i - 1])) { add(word.slice(start, i).join('')); start = i; }
		}
		if (start > 0) add(word.slice(start).join(''));
		word = [];
	};
	for (const r of text) {
		if (/\p{Script=Han}/u.test(r)) { flush(); out.push(r); }
		else if (/[\p{L}\p{Nd}]/u.test(r)) word.push(r);
		else flush();
	}
	flush();
	return out;
}
