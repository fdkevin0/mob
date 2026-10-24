import { expect, it } from 'vitest';
import { ProviderRegistry, Server, Store, memoryProviders, type SQL } from '@mob/core';
import { browserProviders, providerPlugin } from './providers';

const noSQL = {} as SQL;
function setup(listed: Response | (() => never), exchange?: typeof fetch) {
	const asked: { url: string; headers: Headers }[] = [];
	const registry = new ProviderRegistry(memoryProviders(browserProviders()), undefined, false, async (input, init) => {
		asked.push({ url: String(input), headers: new Headers(init?.headers) });
		return typeof listed === 'function' ? listed() : listed.clone();
	});
	const server = new Server({ store: new Store(noSQL), providers: registry, token: 't', version: 'test' }, [providerPlugin(registry, exchange)]);
	const post = (path: string, form: object) => server.fetch(new Request('http://localhost/api/plugins/browser/' + path, { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(form) }));
	const save = (form: object) => post('provider', form);
	return { registry, save, post, asked };
}
const models = () => Response.json({ data: [{ id: 'b-model' }, { id: 'a-model' }] });

it('starts on the demo model and saves a custom provider with the first model it lists', async () => {
	const { registry, save, asked } = setup(models());
	expect(registry.default()).toBe('demo/echo');
	const response = await save({ preset: '', url: 'https://llm.example/v1/', protocol: 'chat', key: ' sk-1 ' });
	expect(await response.json()).toEqual({ default: 'custom/a-model', models: 2 });
	expect(asked[0].url).toBe('https://llm.example/v1/models');
	expect(asked[0].headers.get('Authorization')).toBe('Bearer sk-1');
	expect(registry.providers().providers).toEqual([{ id: 'custom', name: 'Custom', key: 'sk-1', chat: 'https://llm.example/v1' }]);
});

it('asks Anthropic for browser access and keeps a named model when the list fails', async () => {
	const { registry, save, asked } = setup(() => { throw new TypeError('Failed to fetch'); });
	expect((await save({ preset: 'anthropic', key: 'sk-ant', model: 'anthropic/claude-x' })).status).toBe(200);
	expect(asked[0].headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
	expect(registry.default()).toBe('anthropic/claude-x');
	const failed = await save({ preset: 'openai', key: 'sk-2' });
	expect(failed.status).toBe(502);
	expect(await failed.text()).toContain('Could not list OpenAI’s models');
	expect((await save({ preset: 'opencode', key: 'x' })).status).toBe(400);
});

it('turns an OpenRouter sign-in into a key and routes to openrouter/auto', async () => {
	const exchanged: unknown[] = [];
	const exchange = (async (_: RequestInfo | URL, init?: RequestInit) => {
		exchanged.push(JSON.parse(String(init?.body)));
		return Response.json({ key: 'sk-or-1' });
	}) as typeof fetch;
	const { registry, post, asked } = setup(Response.json({ data: [{ id: 'anthropic/claude-x' }, { id: 'openrouter/auto' }] }), exchange);
	expect(await (await post('openrouter', { code: 'c1', verifier: 'v1' })).json()).toEqual({ default: 'openrouter/openrouter/auto', models: 2 });
	expect(exchanged).toEqual([{ code: 'c1', code_verifier: 'v1', code_challenge_method: 'S256' }]);
	expect(asked[0].headers.get('Authorization')).toBe('Bearer sk-or-1');
	expect(registry.providers().providers[0]).toEqual({ id: 'openrouter', preset: 'openrouter', key: 'sk-or-1' });
	expect((await post('openrouter', { code: 'c2' })).status).toBe(400);
});

it('keeps a model ID the vendor lists even when it starts with the provider name', async () => {
	const { registry, save } = setup(Response.json({ data: [{ id: 'anthropic/claude-x' }, { id: 'openrouter/auto' }] }));
	await save({ preset: 'openrouter', key: 'sk-or', model: 'openrouter/auto' });
	expect(registry.default()).toBe('openrouter/openrouter/auto');
	await save({ preset: 'openrouter', key: 'sk-or', model: 'openrouter/anthropic/claude-x' });
	expect(registry.default()).toBe('openrouter/anthropic/claude-x');
});
