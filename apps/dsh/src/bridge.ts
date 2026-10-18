import { randomUUID } from 'node:crypto';
import { Context, Logger } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LoadedPlugin } from './config';

export async function createBridge(plugins: LoadedPlugin[]) {
	const ctx = new Context();
	ctx.logger.exporter({
		export(message) {
			console.error(Logger.format(this, message));
		},
	});
	const server = new Server({ name: 'mob-dsh', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
	const lifetime = new AbortController();
	const running = new Set<Promise<unknown>>();
	let disposing: Promise<void> | undefined;
	const dispose = () =>
		(disposing ??= Promise.resolve().then(async () => {
			lifetime.abort();
			await Promise.allSettled([...running]);
			await ctx.fiber.dispose();
		}));
	const close = async () => {
		await server.close();
		await dispose();
	};
	server.onclose = () => {
		void dispose().catch(console.error);
	};
	server.onerror = (error) => console.error(error);

	try {
		await ctx.plugin(SystemPrompt);
		await ctx.plugin(ToolRuntime);
		// Mount all providers before checking dependencies, regardless of file order.
		const fibers = plugins.map((entry) => ctx.plugin(entry.plugin, entry.config));
		await Promise.all(fibers);
		for (let i = 0; i < fibers.length; i++) {
			const fiber = await fibers[i];
			if (fiber.store === undefined) {
				throw new Error(`DSH plugin ${plugins[i].name} is not active; supply its required services in this configuration`);
			}
		}

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: ctx.tools.schemas().map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters,
			})),
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const call = ctx.tools.execute({
				callId: ToolCallId(randomUUID()),
				name: request.params.name,
				arguments: request.params.arguments ?? {},
				signal: AbortSignal.any([extra.signal, lifetime.signal]),
			});
			running.add(call);
			try {
				const result = await call;
				if (result.additionalContexts?.length || result.concludesTurn) {
					return {
						isError: true,
						content: [
							{
								type: 'text' as const,
								text: 'The DSH tool executed but returned agent-loop directives that this tools bridge cannot apply. Its effects may already have happened.',
							},
						],
					};
				}
				return {
					isError: result.isError,
					// Attachment references belong to DSH; preserve their metadata as text.
					content: result.content.map((block) => ({
						type: 'text' as const,
						text: block.type === 'text' ? block.text : JSON.stringify(block),
					})),
					...(!result.isError ? { structuredContent: { value: result.value } } : {}),
				};
			} finally {
				running.delete(call);
			}
		});
		ctx.on('tools/change', () => {
			if (server.transport && !lifetime.signal.aborted) void server.sendToolListChanged().catch(console.error);
		});
		return { server, close };
	} catch (error) {
		await close();
		throw error;
	}
}
