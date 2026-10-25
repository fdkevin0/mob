// Chrome's built-in model, Gemini Nano through the Prompt API, as a model
// provider of the browser runner. The API exists only on pages, not in
// workers, so the runner's provider calls a base URL that never reaches the
// network: chromeBridge answers it in the worker, as an OpenAI-compatible
// server would, and asks the page to prompt the model.
import type { Provider } from '@mob/core';
import type { ChromeMessage, FromWorker, ToWorker } from './protocol';

// .invalid never resolves, so a request that missed the bridge fails instead of leaving the browser.
export const chromeBase = 'https://built-in.chrome.invalid/v1';
export const chromeModel = 'gemini-nano';

/** chromeProvider is the provider the browser runner saves: free, and without tools, which the model cannot call reliably. */
export const chromeProvider = (): Provider => ({
	id: 'chrome', name: 'Chrome built-in model', chat: chromeBase,
	modelPrefs: { [chromeModel]: { name: 'Gemini Nano (Chrome)', tools: false, context: 6144, output: 1024, cost: { input: 0, output: 0 } } },
});

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type Session = { promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>; destroy(): void };
type Monitor = { addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void };
type LanguageModel = {
	availability(options?: object): Promise<Availability>;
	create(options?: object & { initialPrompts?: ChromeMessage[]; monitor?: (m: Monitor) => void; signal?: AbortSignal }): Promise<Session>;
};
const languageModel = () => (globalThis as { LanguageModel?: LanguageModel }).LanguageModel;

/** chromeModelSupported says whether this browser has the Prompt API at all. */
export const chromeModelSupported = () => !!languageModel();

// Gemini Nano reads and writes only these languages; Chrome warns without one named.
const languages = ['en', 'es', 'ja'];
function options() {
	const own = (globalThis.navigator?.language ?? '').slice(0, 2);
	const lang = languages.includes(own) ? own : 'en';
	return { expectedInputs: [{ type: 'text', languages: [lang] }], expectedOutputs: [{ type: 'text', languages: [lang] }] };
}

function api() {
	const m = languageModel();
	if (!m) throw new Error('This browser has no built-in model. Use Chrome 148 or later on a desktop.');
	return m;
}

/**
 * prepareChromeModel downloads the model if Chrome does not have it yet,
 * reporting progress from 0 to 1. Chrome downloads only after a click, so
 * the dialog calls this from its submit.
 */
export async function prepareChromeModel(progress: (loaded: number) => void) {
	const m = api();
	const state = await m.availability(options());
	if (state === 'unavailable') throw new Error('Chrome cannot run its built-in model on this device. It needs a desktop with about 22 GB of free disk space and a capable GPU or 16 GB of memory.');
	const session = await m.create({ ...options(), monitor: monitor => monitor.addEventListener('downloadprogress', e => progress(e.loaded)) });
	session.destroy();
}

/** promptChrome answers a conversation: everything before its last user message is the session's history. */
export async function promptChrome(messages: ChromeMessage[], signal: AbortSignal, text: (delta: string) => void) {
	const history = [...messages];
	const last = history.pop();
	if (last?.role !== 'user') throw new Error('There is no message for the model to answer.');
	// The Prompt API takes one system prompt, first.
	const system = history.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
	const initialPrompts = [...(system ? [{ role: 'system' as const, content: system }] : []), ...history.filter(m => m.role !== 'system' && m.content)];
	const session = await api().create({ ...options(), initialPrompts, signal });
	try {
		const reader = session.promptStreaming(last.content, { signal }).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) text(value);
		}
	} finally {
		session.destroy();
	}
}

const encoder = new TextEncoder();
const event = (data: unknown) => encoder.encode('data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n');
const text = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(p => (p as { text?: string })?.text ?? '').join('') : '');

/**
 * chromeBridge is the worker's side: fetcher serves chromeBase from the page's
 * answers and passes every other request on, and receive takes those answers.
 */
export function chromeBridge(post: (m: FromWorker) => void) {
	const open = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
	let next = 0;
	const fetcher = (passOn: typeof fetch): typeof fetch => async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (!url.startsWith(chromeBase + '/')) return passOn(input, init);
		const path = url.slice(chromeBase.length);
		if (path === '/models') return Response.json({ data: [{ id: chromeModel, supported_parameters: [] }] });
		if (path !== '/chat/completions' || init?.method !== 'POST') return Response.json({ error: { message: 'not found' } }, { status: 404 });
		const signal = init.signal ?? undefined;
		signal?.throwIfAborted();
		const body = JSON.parse(String(init.body)) as { messages?: { role?: string; content?: unknown }[] };
		const messages = (body.messages ?? []).filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: text(m.content) }) as ChromeMessage);
		const id = ++next;
		const stop = () => { if (open.delete(id)) post({ type: 'chrome-abort', id }); };
		const stream = new ReadableStream<Uint8Array>({
			start: c => {
				open.set(id, c);
				post({ type: 'chrome', id, messages });
			},
			cancel: stop,
		});
		signal?.addEventListener('abort', () => {
			const c = open.get(id);
			stop();
			c?.error(signal.reason);
		}, { once: true });
		return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
	};
	const receive = (m: Extract<ToWorker, { type: 'chrome-text' | 'chrome-end' | 'chrome-error' }>) => {
		const c = open.get(m.id);
		if (!c) return;
		if (m.type === 'chrome-text') { c.enqueue(event({ choices: [{ index: 0, delta: { content: m.text } }] })); return; }
		open.delete(m.id);
		if (m.type === 'chrome-error') { c.error(new Error(m.error)); return; }
		c.enqueue(event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
		c.enqueue(event('[DONE]'));
		c.close();
	};
	return { fetcher, receive };
}
