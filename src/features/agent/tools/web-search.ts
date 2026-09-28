import { tool } from 'ai';
import { z } from 'zod';

/** Cap on results returned to the model — keeps the payload small (docs/adr/0022). */
const MAX_RESULTS = 5;

export interface WebSearchDeps {
	/** Injected for tests; defaults to the global `fetch` at the call site. */
	fetch: typeof fetch;
	/** Tavily API key (`Authorization: Bearer …`). The tool is only registered when set. */
	apiKey: string;
}

/** One ranked hit as exposed to the model — the retrieval primitive, no raw page text. */
interface SearchResult {
	title: string;
	url: string;
	content: string;
	score: number;
}

/**
 * **Web search tool** (`web_search`, docs/adr/0022). Discovers pages via **Tavily**
 * (`POST https://api.tavily.com/search`, `search_depth: 'basic'`) and returns the
 * ranked `results[]` — `{ title, url, content, score }` — capped at five. It is a
 * retrieval primitive: it finds URLs, it does not read them. To read a hit the
 * agent composes with the **Markdown fetch tool** (`fetch_url`). No `answer` and no
 * raw page content are requested, so the agent stays the only synthesizer and the
 * context budget stays small.
 *
 * Gated on `env.TAVILY_API_KEY`: `buildBuiltinTools` only registers `web_search`
 * when the key is present, so the model never sees a tool it cannot use. A non-200
 * from Tavily throws — a real failure belongs in the Debug trace (docs/adr/0011),
 * not silently masked as "no results".
 */
export function webSearchTool(deps: WebSearchDeps) {
	return tool({
		description:
			'Search the web for current information and return ranked results (title, url, snippet). ' +
			'Use this to discover relevant pages; to read a result in full, call fetch_url on its url.',
		inputSchema: z.object({
			query: z.string().describe('The search query'),
		}),
		execute: async ({ query }): Promise<{ results: SearchResult[] }> => {
			const res = await deps.fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${deps.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ query, search_depth: 'basic', max_results: MAX_RESULTS }),
			});

			if (!res.ok) {
				throw new Error(`web_search failed: Tavily returned ${res.status} ${res.statusText}`);
			}

			const body = (await res.json()) as { results?: Array<Partial<SearchResult>> };
			const results: SearchResult[] = (body.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				content: r.content ?? '',
				score: r.score ?? 0,
			}));

			return { results };
		},
	});
}
