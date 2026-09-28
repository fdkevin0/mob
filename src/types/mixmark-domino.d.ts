/**
 * `@mixmark-io/domino` ships its `.d.ts` under the ambient module name
 * `'domino'` (its historical package name), not `'@mixmark-io/domino'`, so
 * importing the actual package name resolves to no module. This declares
 * the small DOM subset used by the Worker-side HTML helpers.
 */
declare module '@mixmark-io/domino' {
	interface Element {
		readonly textContent: string | null;
		readonly innerHTML: string;
		readonly outerHTML: string;
		querySelectorAll(selector: string): ArrayLike<Element>;
		remove(): void;
		insertAdjacentHTML(position: 'afterbegin' | 'afterend', html: string): void;
	}

	interface Document extends Element {
		readonly body: Element;
		readonly head: Element;
		readonly documentElement: Element;
	}

	export function createDocument(html?: string): Document;
}
