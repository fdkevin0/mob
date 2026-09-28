/**
 * Deterministic HTML→Markdown via `turndown`, shared by `fetch_url`
 * (`src/features/agent/tools/fetch-url.ts`) and email triage (`src/ai/email.ts`).
 *
 * Bundlers resolve `turndown`'s package.json `"browser"` field for the
 * Workers build. That build's HTML-string parsing path checks
 * `typeof window !== 'undefined'`, finds it `undefined` (Workers has no
 * `window` any more than it has `document`), and falls through to a
 * `document.implementation.createHTMLDocument(...)` call that assumes a
 * real browser DOM — throwing `document is not defined` at runtime
 * (verified against the exact Workers error). Polyfilling `DOMParser`
 * doesn't help: with `window` undefined, turndown's browser build never
 * even looks at `DOMParser`.
 *
 * The fix: sidestep turndown's internal HTML-string parsing entirely.
 * `TurndownService.turndown()` also accepts an already-parsed DOM Node
 * (see its `RootNode` branch for non-string input) — so we parse the HTML
 * ourselves with `@mixmark-io/domino` (a pure-JS HTML5 parser, already a
 * `turndown` dependency and the same fallback its own Node build uses) and
 * hand turndown the resulting `<body>` element instead of a string.
 */
export async function convertViaTurndown(html: string): Promise<string> {
	const domino = await import('@mixmark-io/domino');
	const TurndownService = (await import('turndown')).default;
	const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
	const doc = domino.createDocument(html);
	return turndown.turndown(doc.body as never);
}

/** Submit one HTML document to Workers AI and normalize its result union. */
export async function convertViaWorkersAiMarkdown(
	ai: Pick<Ai, 'toMarkdown'>,
	html: string,
	name: string,
	requireMarkdownFormat = false
): Promise<string | null> {
	const [result] = await ai.toMarkdown([{ name, blob: new Blob([html], { type: 'text/html' }) }]);
	if (!result || !('data' in result) || (requireMarkdownFormat && result.format !== 'markdown')) return null;
	return result.data ?? '';
}
