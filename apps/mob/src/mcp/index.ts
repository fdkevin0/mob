// The MCP plugin: tools of the configured and installed MCP servers, the
// catalog tool_install draws on, /mcp and /signin.
import { body, clientEmail, clientTelegram, clientTUI, clientWeb, clientWeChat, CommandError, HTTPError, interactive, type Plugin } from '@mob/core';
import { z } from 'zod';
import type { Environment } from '../config';
import type { HostPlugin } from '../local';
import { validateRegistry } from './catalog';
import { decode, validate } from './config';
import { Hub } from './hub';

function configure(hub: Hub, e: Environment) {
	hub.configureRegistry(e.mcpRegistry);
	return hub.configure(decode(e.mcpServers));
}

function plugin(hub: Hub): Plugin {
	const parse = <T>(schema: z.ZodType<T>, data: unknown) => {
		const r = schema.safeParse(data);
		if (!r.success) throw new HTTPError(400, r.error.issues[0]?.message ?? 'invalid request');
		return r.data;
	};
	return {
		name: 'mcp',
		routes: [
			{ method: 'GET', path: 'overview', handle: async () => hub.overview() },
			{ method: 'POST', path: 'install', handle: async req => hub.installFromWeb(parse(z.object({ url: z.string().url() }), await body(req, undefined, ['url'])).url) },
			{ method: 'POST', path: 'remove', handle: async req => {
				await hub.remove(parse(z.object({ name: z.string().min(1) }), await body(req, undefined, ['name'])).name);
				return { removed: true };
			} },
			{ method: 'POST', path: 'signin', handle: async req => ({ name: hub.finishSignIn(parse(z.object({ address: z.string().min(1) }), await body(req, undefined, ['address'])).address) }) },
		],
		commands: [{
			name: 'mcp', usage: '/mcp [remove NAME]', summary: 'Show MCP servers and their tools, or remove an installed one', clients: interactive, ownerOnly: true,
			run: async call => {
				if (!call.fields.length) return { markdown: hub.describe() };
				if (call.fields.length === 2 && call.fields[0] === 'remove') {
					try { await hub.remove(call.fields[1]!); } catch (err) { throw new CommandError(400, (err as Error).message); }
					return { markdown: `Removed ${call.fields[1]} and its sign-in.` };
				}
				throw new CommandError(400, 'usage: /mcp [remove NAME]');
			},
		}, {
			name: 'signin', usage: '/signin ADDRESS', summary: 'Finish signing in to an MCP server with the address the browser was sent to',
			clients: [clientWeb, clientTUI, clientTelegram, clientWeChat, clientEmail], ownerOnly: true,
			run: async call => {
				if (call.fields.length !== 1) throw new CommandError(400, 'usage: /signin ADDRESS');
				let server: string;
				try { server = hub.finishSignIn(call.fields[0]!); } catch (err) { throw new CommandError(400, (err as Error).message); }
				return { markdown: `Signed in to ${server}; connecting. /mcp shows its tools.` };
			},
		}],
		tools: [hub.installTool()],
		source: () => hub.tools(),
		entries: () => hub.entries(),
		background: { name: 'mcp', start: () => {
			const servers = hub.configured();
			if (!Object.keys(servers).length) return undefined;
			return (signal, status) => hub.serve(servers, signal, status);
		} },
	};
}

export const mcpPlugin: HostPlugin = {
	validate: e => { validate(decode(e.mcpServers)); validateRegistry(e.mcpRegistry); },
	attach(e, server) {
		const hub = new Hub(server.options.store);
		hub.changed = () => server.extensions.reload('mcp');
		configure(hub, e);
		return {
			plugins: [plugin(hub)],
			reload: next => { if (configure(hub, next)) return server.extensions.reload('mcp'); },
		};
	},
};
