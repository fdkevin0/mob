// magpie (https://github.com/yetone/magpie) is a gateway on the user's own
// machine that serves every provider they signed in to there through the
// OpenAI and Anthropic APIs.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { magpiePort } from '@mob/core';

/** findMagpie is the gateway's base URLs; it fails when nothing answers there, or what answers is not magpie. */
export async function findMagpie() {
	const xdg = process.env.XDG_CONFIG_HOME;
	const dir = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
	let port = magpiePort;
	try {
		const settings = await Bun.file(join(dir, 'magpie', 'settings.json')).json() as { port?: number };
		if (settings.port && settings.port > 0 && settings.port < 65536) port = settings.port;
	} catch { /* default port */ }
	const address = 'http://127.0.0.1:' + port;
	let response: Response;
	try {
		response = await fetch(address + '/api/hello', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
	} catch { throw new Error(`magpie is not running at ${address}; start the app or \`magpie serve\``); }
	const hello = await response.json().catch(() => ({})) as { name?: string };
	if (response.status !== 200 || hello.name !== 'magpie') throw new Error(`${address} is not magpie`);
	return { chat: address + '/v1', anthropic: address };
}
