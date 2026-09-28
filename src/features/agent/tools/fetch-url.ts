import { tool } from 'ai';
import { z } from 'zod';
import type { Env } from '../../../core/env';
import { convertViaTurndown, convertViaWorkersAiMarkdown } from '../../../utils/html-to-markdown';

/** Cap on returned markdown so a huge page can't blow the context budget. */
const MAX_FETCH_CHARS = 12000;

export interface FetchUrlDeps {
	/** Injected for tests; defaults to the global `fetch` at the call site. */
	fetch: typeof fetch;
	/** Workers AI binding — used for the HTML→Markdown fallback when `parser === 'ai'`. */
	ai: Env['AI'];
	/**
	 * Which HTML→Markdown converter to use when the origin doesn't return
	 * `text/markdown`. `'turndown'` (default) is deterministic and free;
	 * `'ai'` delegates to Workers AI (`toMarkdown`).
	 */
	parser?: 'turndown' | 'ai';
}

/**
 * **Markdown fetch tool** (`fetch_url`, PRD #72, docs/adr/0015). Fetches a URL with
 * `Accept: text/markdown` (**Cloudflare Markdown for Agents**). If the origin zone
 * has the feature enabled the response *is* markdown and passes through; otherwise
 * (the common case for an arbitrary URL) the fetched HTML is converted:
 *
 * - `'turndown'` parser (default): deterministic HTML→Markdown via the `turndown`
 *   library — free, millisecond-fast, and testable.
	 * - `'ai'` parser: delegates to `env.AI.toMarkdown()` — pay-per-token,
	 *   higher latency, but may handle
 *   non-standard HTML better.
 */
export function fetchUrlTool(deps: FetchUrlDeps) {
	const parser = deps.parser ?? 'turndown';

	return tool({
		description: 'Fetch a web page by URL and return its content as Markdown for reading or answering questions about.',
		inputSchema: z.object({
			url: z.string().url().describe('The absolute http(s) URL to fetch'),
		}),
		execute: async ({ url }) => {
			const res = await deps.fetch(url, { headers: { Accept: 'text/markdown' } });
			const contentType = res.headers.get('content-type') ?? '';

			if (contentType.includes('text/markdown')) {
				return { markdown: truncate(await res.text()) };
			}

			const html = await res.text();

			if (parser === 'ai') {
				return { markdown: truncate((await convertViaWorkersAiMarkdown(deps.ai, html, 'page.html')) ?? '') };
			}

			// Default: turndown (deterministic, free, fast)
			return { markdown: truncate(await convertViaTurndown(html)) };
		},
	});
}

function truncate(markdown: string): string {
	if (markdown.length <= MAX_FETCH_CHARS) return markdown;
	return `${markdown.slice(0, MAX_FETCH_CHARS)}\n\n…[truncated]`;
}
