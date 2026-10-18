import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridge } from '../src/bridge';
import { loadPlugins, type LoadedPlugin } from '../src/config';

async function connect(plugins: LoadedPlugin[]) {
	const bridge = await createBridge(plugins);
	const client = new Client({ name: 'test', version: '1' });
	const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	await bridge.server.connect(serverTransport);
	await client.connect(clientTransport);
	return {
		client,
		close: async () => {
			await client.close();
			await bridge.close();
		},
	};
}

test('the DSH defineTool example works over MCP, with DSH argument validation', async () => {
	const plugins = await loadPlugins(fileURLToPath(new URL('../examples/plugins.json', import.meta.url)));
	const { client, close } = await connect(plugins);
	try {
		const { tools } = await client.listTools();
		assert.equal(tools[0].name, 'greet');
		assert.deepEqual(tools[0].inputSchema.required, ['name']);
		const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });
		assert.deepEqual(result.content, [{ type: 'text', text: 'Hello, Ada!' }]);
		assert.deepEqual(result.structuredContent, { value: 'Hello, Ada!' });
		assert.equal((await client.callTool({ name: 'greet', arguments: { name: 7 } })).isError, true);
		assert.equal((await client.callTool({ name: 'missing' })).isError, true);
	} finally {
		await close();
	}
});

declare module '@deepseek-ai/cordis' {
	interface Context {
		mobTestGreeting: Greeting;
	}
}
class Greeting extends Service {
	constructor(ctx: Context) {
		super(ctx, 'mobTestGreeting');
	}
	text = 'from provider';
}

test('Cordis resolves services out of order and cleans up tool registrations and effects', async () => {
	let remove = () => {};
	let disposed = false;
	const { client, close } = await connect([
		{
			name: 'consumer',
			plugin: {
				inject: ['tools', 'mobTestGreeting'],
				apply(ctx: Context) {
					remove = ctx.tools.register(
						defineTool({
							name: 'dependency',
							description: 'Uses another plugin',
							parameters: {},
							output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
							async execute() {
								return ctx.mobTestGreeting.text;
							},
						}),
					);
					ctx.effect(() => () => {
						disposed = true;
					});
				},
			},
		},
		{ name: 'provider', plugin: Greeting },
	]);
	try {
		const result = await client.callTool({ name: 'dependency' });
		assert.deepEqual(result.structuredContent, { value: 'from provider' });
		const changed = Promise.withResolvers<void>();
		client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed.resolve());
		remove();
		await changed.promise;
		assert.deepEqual((await client.listTools()).tools, []);
		assert.equal((await client.callTool({ name: 'dependency' })).isError, true);
	} finally {
		await close();
	}
	assert.equal(disposed, true);
});

test('unavailable services and failing plugin setup fail startup and dispose earlier effects', async () => {
	let disposed = 0;
	const resource: LoadedPlugin = {
		name: 'resource',
		plugin: (ctx: Context) => {
			ctx.effect(() => () => {
				disposed++;
			});
		},
	};
	await assert.rejects(
		createBridge([resource, { name: 'missing', plugin: { inject: ['unavailableMobService'], apply() {} } }]),
		/missing.*required services/,
	);
	assert.equal(disposed, 1);
	await assert.rejects(
		createBridge([
			resource,
			{
				name: 'broken',
				plugin: () => {
					throw new Error('broken setup');
				},
			},
		]),
		/broken setup/,
	);
	assert.equal(disposed, 2);
});

test('DSH execution hooks can deny a call without running its body', async () => {
	let executed = false;
	const { client, close } = await connect([
		{
			name: 'guard',
			plugin: {
				inject: ['tools'],
				apply(ctx: Context) {
					ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'blocked by plugin' }));
					ctx.tools.register(
						defineTool({
							name: 'guarded',
							description: '',
							parameters: {},
							output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
							async execute() {
								executed = true;
								return 'ran';
							},
						}),
					);
				},
			},
		},
	]);
	try {
		const result = await client.callTool({ name: 'guarded' });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /blocked by plugin/);
		assert.equal(executed, false);
	} finally {
		await close();
	}
});

test('MCP cancellation reaches the DSH tool before its plugin is disposed', async () => {
	const started = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	let cleaned = false;
	const { client, close } = await connect([
		{
			name: 'wait',
			plugin: {
				inject: ['tools'],
				apply(ctx: Context) {
					ctx.effect(() => () => {
						cleaned = true;
					});
					ctx.tools.register(
						defineTool({
							name: 'wait',
							description: '',
							parameters: {},
							output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
							async execute(_, exec) {
								started.resolve();
								await new Promise<void>((resolve) => exec.signal.addEventListener('abort', () => resolve(), { once: true }));
								assert.equal(cleaned, false);
								cancelled.resolve();
								return 'cancelled';
							},
						}),
					);
				},
			},
		},
	]);
	try {
		const controller = new AbortController();
		const result = client.callTool({ name: 'wait' }, undefined, { signal: controller.signal });
		const rejected = assert.rejects(result);
		await started.promise;
		controller.abort();
		await rejected;
		await cancelled.promise;
	} finally {
		await close();
	}
	assert.equal(cleaned, true);
});

test('agent-loop directives are reported as unsupported rather than silently ignored', async () => {
	const { client, close } = await connect([
		{
			name: 'end-turn',
			plugin: {
				inject: ['tools'],
				apply(ctx: Context) {
					ctx.tools.register(
						defineTool({
							name: 'finish',
							description: '',
							parameters: {},
							output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
							async execute(_, exec) {
								exec.concludeTurn();
								return 'done';
							},
						}),
					);
				},
			},
		},
	]);
	try {
		const result = await client.callTool({ name: 'finish' });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /agent-loop directives/);
	} finally {
		await close();
	}
});
