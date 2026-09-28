import { normalizeServerId } from 'agents';
import { Bot } from '../../core/bot';
import { Command } from '../../core/cmd';
import { Env } from '../../core/env';
import type { Capability } from '../../core/principal';
import { parseMcpCommand } from './parse';
import { mcpRegistry, type McpServerRow } from './registry';
import type * as Telegram from 'telegram-bot-api-types';

/**
 * Admin-only `/mcp` command — manages the global MCP server registry that each
 * Conversation Agent reconciles its `this.mcp` against (see docs/adr/0008).
 */
export class McpCommand implements Command {
	name = 'mcp';
	description = 'Manage MCP servers (list/add/rm/on/off)';
	adminOnly = true;
	capability: Capability = 'manage_mcp';

	handler = async (env: Env, _msg: Telegram.Message, _bot: Bot, args: string[]) => {
		// args[0] is the command name; the subcommand + its args follow.
		const cmd = parseMcpCommand(args.slice(1));

		switch (cmd.action) {
			case 'help':
				return helpText();

			case 'error':
				return cmd.message;

			case 'list': {
				const rows = await mcpRegistry.list(env);
				if (rows.length === 0) return 'No MCP servers registered. Add one with /mcp add <name> <url>';
				return rows.map(formatRow).join('\n');
			}

			case 'add': {
				// The Agents SDK namespaces tools by a normalized server id, so two
				// differently-spelled names that normalize to the same id would
				// collide at connect time. Reject before storing.
				const wantId = normalizeServerId(cmd.name);
				const clash = (await mcpRegistry.list(env)).find(
					(s) => s.name !== cmd.name && normalizeServerId(s.name) === wantId
				);
				if (clash) return `Name conflicts with existing server "${clash.name}" (same normalized id).`;

				const row = await mcpRegistry.upsert(env, cmd);
				return `Saved MCP server "${row.name}" (${row.authType}, ${row.enabled ? 'enabled' : 'disabled'}).`;
			}

			case 'rm': {
				const ok = await mcpRegistry.remove(env, cmd.name);
				return ok ? `Removed MCP server "${cmd.name}".` : `No MCP server named "${cmd.name}".`;
			}

			case 'on':
			case 'off': {
				const enabled = cmd.action === 'on';
				const ok = await mcpRegistry.setEnabled(env, cmd.name, enabled);
				if (!ok) return `No MCP server named "${cmd.name}".`;
				return `MCP server "${cmd.name}" ${enabled ? 'enabled' : 'disabled'}.`;
			}
		}
	};
}

function formatRow(row: McpServerRow): string {
	const state = row.enabled ? '🟢' : '⚪️';
	const auth = row.authType === 'bearer' ? ' 🔑' : '';
	return `${state} ${row.name}${auth} — ${row.url}`;
}

function helpText(): string {
	return [
		'Manage MCP servers:',
		'/mcp list',
		'/mcp add <name> <https-url> [token]',
		'/mcp rm <name>',
		'/mcp on <name>',
		'/mcp off <name>',
	].join('\n');
}
