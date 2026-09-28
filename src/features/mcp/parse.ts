/**
 * Pure parser for the admin `/mcp` command (see docs/adr/0008). Turns the raw
 * argument tokens into a validated, discriminated command. No D1, no runtime —
 * the network-bound CRUD lives elsewhere; this is the unit-tested seam.
 *
 * Grammar (tokens after `/mcp`):
 *   list
 *   add <name> <https-url> [token]
 *   rm  <name>
 *   on  <name>
 *   off <name>
 */

export type McpCommand =
	| { action: 'list' }
	| { action: 'add'; name: string; url: string; token?: string }
	| { action: 'rm' | 'on' | 'off'; name: string }
	| { action: 'help' }
	| { action: 'error'; message: string };

const USAGE =
	'Usage:\n' +
	'/mcp list\n' +
	'/mcp add <name> <https-url> [token]\n' +
	'/mcp rm <name>\n' +
	'/mcp on <name>\n' +
	'/mcp off <name>';

/** Parse the tokens that follow `/mcp` (the subcommand and its arguments). */
export function parseMcpCommand(tokens: string[]): McpCommand {
	const [sub, ...rest] = tokens.map((t) => t.trim()).filter((t) => t.length > 0);

	switch ((sub ?? '').toLowerCase()) {
		case undefined:
		case '':
		case 'help':
			return { action: 'help' };

		case 'list':
			return { action: 'list' };

		case 'add': {
			const [name, url, token] = rest;
			if (!name) return err('Missing server name.');
			if (!url) return err('Missing server URL.');
			if (!isHttpUrl(url)) return err('URL must start with http:// or https://');
			return token ? { action: 'add', name, url, token } : { action: 'add', name, url };
		}

		case 'rm':
		case 'on':
		case 'off': {
			const [name] = rest;
			if (!name) return err('Missing server name.');
			return { action: sub as 'rm' | 'on' | 'off', name };
		}

		default:
			return err(`Unknown subcommand "${sub}".`);
	}
}

function err(message: string): McpCommand {
	return { action: 'error', message: `${message}\n\n${USAGE}` };
}

function isHttpUrl(value: string): boolean {
	try {
		const u = new URL(value);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}
