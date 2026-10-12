import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { MobClient } from '@mob/client';
import { App } from './App';

const { values } = parseArgs({
	options: {
		url: { type: 'string' },
		'token-file': { type: 'string' },
		help: { type: 'boolean' },
	},
});
if (values.help) {
	console.log('TS TUI pilot (Bun): --url URL --token-file PATH, or MOB_URL / MOB_TOKEN\nConnects only; mob tui remains the Go fallback.');
} else {
	try {
		if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive TTY is required.');
		const url = (values.url ?? process.env.MOB_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
			throw new Error('Use an HTTP(S) service URL without embedded credentials.');
		const token = (values['token-file'] ? await readFile(values['token-file'], 'utf8') : (process.env.MOB_TOKEN ?? '')).trim();
		if (!token) throw new Error('Provide --token-file PATH or MOB_TOKEN for the existing Go service.');
		const client = new MobClient({ url, token });
		const conversations = await client.listConversations();
		const conversation = conversations[0] ?? (await client.createConversation());
		const initial = await client.openConversation(conversation.id);
		const renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: 'alternate-screen', useMouse: true });
		createRoot(renderer).render(<App client={client} initial={initial} conversation={conversation} onExit={() => renderer.destroy()} />);
		await renderer.closed;
	} catch (error) {
		console.error(`Mob TUI: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
