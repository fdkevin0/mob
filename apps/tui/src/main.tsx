import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { run } from './run';

const { values } = parseArgs({
	options: {
		url: { type: 'string' },
		'token-file': { type: 'string' },
		help: { type: 'boolean' },
	},
});
if (values.help) {
	console.log('Mob terminal UI: --url URL --token-file PATH, or MOB_URL / MOB_TOKEN. mob tui starts it for the local service.');
} else {
	try {
		const url = (values.url ?? process.env.MOB_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
			throw new Error('Use an HTTP(S) service URL without embedded credentials.');
		const token = (values['token-file'] ? await readFile(values['token-file'], 'utf8') : (process.env.MOB_TOKEN ?? '')).trim();
		if (!token) throw new Error('Provide --token-file PATH or MOB_TOKEN.');
		await run({ url, token });
	} catch (error) {
		console.error(`Mob TUI: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
