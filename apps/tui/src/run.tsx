import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { MobClient } from '@mob/client';
import { App } from './App';

/** run shows the terminal UI for the service at url until the user leaves. */
export async function run({ url, token }: { url: string; token: string }) {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive TTY is required.');
	const client = new MobClient({ url, token });
	const conversations = await client.listConversations();
	const conversation = conversations[0] ?? (await client.createConversation());
	const initial = await client.openConversation(conversation.id);
	const renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: 'alternate-screen', useMouse: true });
	createRoot(renderer).render(<App client={client} initial={initial} conversation={conversation} onExit={() => renderer.destroy()} />);
	await renderer.closed;
}
