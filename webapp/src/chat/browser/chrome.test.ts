import { afterEach, expect, it, vi } from 'vitest';
import { ProviderRegistry, Server, Store, memoryProviders, type SQL } from '@mob/core';
import { chromeBridge, promptChrome } from './chrome';
import type { FromWorker } from './protocol';
import { browserProviders, providerPlugin } from './providers';

afterEach(() => vi.unstubAllGlobals());

// A stand-in for Chrome's Prompt API that streams the words it is told to say.
function languageModel(words: string[]) {
	const created: object[] = [];
	const destroyed = vi.fn();
	vi.stubGlobal('LanguageModel', {
		availability: async () => 'available',
		create: async (options: object) => {
			created.push(options);
			return {
				promptStreaming: (input: string) => new ReadableStream<string>({ start: c => { for (const w of words) c.enqueue(w); c.close(); void input; } }),
				destroy: destroyed,
			};
		},
	});
	return { created, destroyed };
}

// The worker's registry with the bridge, and a page that answers its prompts in the same thread.
function setup() {
	const prompted: FromWorker[] = [];
	const bridge = chromeBridge(m => {
		prompted.push(m);
		if (m.type !== 'chrome') return;
		void promptChrome(m.messages, new AbortController().signal, text => bridge.receive({ type: 'chrome-text', id: m.id, text }))
			.then(() => bridge.receive({ type: 'chrome-end', id: m.id }), e => bridge.receive({ type: 'chrome-error', id: m.id, error: (e as Error).message }));
	});
	const network = vi.fn(async () => new Response('network'));
	const registry = new ProviderRegistry(memoryProviders(browserProviders()), undefined, false, bridge.fetcher(network));
	const server = new Server({ store: new Store({} as SQL), providers: registry, token: 't', version: 'test' }, [providerPlugin(registry)]);
	const post = (path: string) => server.fetch(new Request('http://localhost/api/plugins/browser/' + path, { method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{}' }));
	return { registry, post, prompted, network, bridge };
}

it('saves Chrome’s model as a free one without tools and answers through the page', async () => {
	const { created, destroyed } = languageModel(['Hello', ' there']);
	const { registry, post, prompted, network } = setup();
	expect(await (await post('chrome')).json()).toEqual({ default: 'chrome/gemini-nano', models: 1 });
	const p = registry.providers().providers[0];
	expect(registry.info(p, 'gemini-nano')).toMatchObject({ tools: false, free: true, context: 6144 });
	const texts: string[] = [];
	const result = await registry.resolve('chrome/gemini-nano').stream({
		system: 'Be brief.',
		messages: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }, { role: 'user', text: 'Again?' }],
	}, async (kind, text) => { if (kind === 'text') texts.push(text); });
	expect(result.text).toBe('Hello there');
	expect(texts).toEqual(['Hello', ' there']);
	expect(created[0]).toMatchObject({ initialPrompts: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }] });
	expect(destroyed).toHaveBeenCalled();
	expect(prompted.filter(m => m.type === 'chrome')).toHaveLength(1);
	// Nothing went to the network.
	expect(network).not.toHaveBeenCalled();
});

it('passes other providers to the network and reports the page’s errors', async () => {
	vi.stubGlobal('LanguageModel', { availability: async () => 'available', create: async () => { throw new Error('The model is busy.'); } });
	const { registry, post, network, bridge } = setup();
	await post('chrome');
	await expect(registry.resolve('chrome/gemini-nano').stream({ system: '', messages: [{ role: 'user', text: 'Hi' }] }, async () => {})).rejects.toThrow('The model is busy.');
	expect(await (await bridge.fetcher(network)('https://api.example/v1/models')).text()).toBe('network');
});

it('tells the page to stop when the request is cancelled', async () => {
	const posted: FromWorker[] = [];
	const bridge = chromeBridge(m => posted.push(m));
	const abort = new AbortController();
	const response = await bridge.fetcher(fetch)('https://built-in.chrome.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }), signal: abort.signal });
	expect(posted).toEqual([{ type: 'chrome', id: 1, messages: [{ role: 'user', content: 'Hi' }] }]);
	abort.abort();
	expect(posted[1]).toEqual({ type: 'chrome-abort', id: 1 });
	await expect(response.text()).rejects.toThrow();
});
