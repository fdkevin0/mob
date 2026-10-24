import { expect, it } from 'vitest';
import { ProviderRegistry, Server, Store, memoryProviders, type SQL } from '@mob/core';
import { browserProviders, providerPlugin } from './providers';

const noSQL = {} as SQL;
function setup(listed: Response | (() => never)) {
	const asked: { url: string; headers: Headers }[] = [];
	const registry = new ProviderRegistry(memoryProviders(browserProviders()), undefined, false, async (input, init) => {
		asked.push({ url: String(input), headers: new Headers(init?.headers) });
		return typeof listed === 'function' ? listed() : listed.clone();
	});
	const server = new Server({ store: new Store(noSQL), providers: registry, token: 't', version: 'test' }, [providerPlugin(registry)]);
	const save = (form: object) => server.fetch(new Request('http://localhost/api/plugins/browser/provider', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(form) }));
	return { registry, save, asked };
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
