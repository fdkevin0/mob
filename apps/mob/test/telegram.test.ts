import { expect, test } from 'bun:test';
import { ConversationService, DemoModel, Store, newID, type Models } from '@mob/core';
import { openBun } from '@mob/core/sqlite/bun';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, buttons, type Update } from '../src/telegram/api';
import { menu, picked, Service, setPlaceholderTimings, texts } from '../src/telegram/service';

const models: Models = { default: () => 'demo/echo', resolve: () => new DemoModel(), setDefault: () => new DemoModel().ref, list: async () => [] };
function service() {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-tg-')), 'mob.sqlite'))).open();
	return new Service(store, new ConversationService(store, models));
}
const config = { enabled: true, token: '1:x', userId: 7 };
const signal = () => new AbortController().signal;

test('replies run registry commands', async () => {
	const s = service();
	const reply = (text: string) => s.reply(config, 'bot', newID(), text, signal());
	expect(await reply('/start')).toBe(texts.help!);
	expect(s.store.list()).toEqual([]);
	expect(await reply('/new')).toBe('New conversation started.');
	expect(s.store.setting<string>('telegram-conversation:bot:7')).toBeTruthy();
	const asked = await reply('/remember 简洁');
	expect(asked).toContain('**Approval needed**\n```\nremember\nfact: 简洁\n```');
	expect(asked).toContain('Tap a button to decide, or reply /deny with a reason');
	expect(await reply('/approve')).toContain('approved remember and it ran');
	expect(await reply('/approve')).toContain('0 requests are pending');
	await reply('/remember 冗长');
	expect(await reply('/deny 太长了')).toContain('The user denied the remember request and said: 太长了');
	await reply('/remember 喝茶');
	expect(await reply('/approve always')).toContain('approved remember and it ran');
	expect(await reply('/remember 喝咖啡')).not.toContain('Approval needed');
	expect(await reply('/grants')).toContain('remember: every call — every conversation');
	expect(await reply('/revoke all')).toContain('Forgot 1');
});

test('buttons, taps and menus', () => {
	const a = newID();
	expect(buttons([{ id: a, tool: 'remember', input: {} }])).toEqual([[{ text: 'Approve', callback_data: '/approve ' + a }, { text: 'Deny', callback_data: '/deny ' + a }], [{ text: 'Allow in conversation', callback_data: `/approve ${a} conversation` }, { text: 'Always allow', callback_data: `/approve ${a} always` }]]);
	const bot = new Bot(config);
	const tap = (from: number, data: string) => bot.tapped({ update_id: 9, callback_query: { id: 'q', data, from: { id: from } } } as Update);
	expect(tap(8, '/new')[1]).toBeUndefined();
	const [u, ack] = tap(7, '/new');
	expect(ack).toBeDefined();
	expect(u.message).toMatchObject({ text: '/new', tap: true, chat: { id: 7, type: 'private' } });
	expect(menu([{ name: 'ok', usage: '/ok', summary: 'Fine', clients: [] }, { name: 'Bad-Name', usage: '', summary: 'x', clients: [] }])).toEqual([{ command: 'ok', description: 'Fine' }]);
	expect(picked('/open abc', { inline_keyboard: [] })).toBe(true);
	expect(picked('/_confirm /forget all', { inline_keyboard: [] })).toBe(true);
	expect(picked('/new', { inline_keyboard: [[{ text: '', callback_data: '/open x' }]] })).toBe(true);
	expect(picked('/new', { inline_keyboard: [[{ text: '', callback_data: '/list' }]] })).toBe(false);
	const s = service();
	const long = '/model ' + 'x'.repeat(80);
	const token = s.callback(long);
	expect(token).toStartWith('#');
	expect(s.command(token)).toBe(long);
	expect(s.command('#nope')).toBe('');
});

test('the loop answers the owner once and keeps the offset', async () => {
	setPlaceholderTimings({ delay: 10_000 });
	const s = service();
	const sent: Record<string, unknown>[] = [];
	let polls = 0;
	const stop = new AbortController();
	const fetcher = (async (url: string, init: RequestInit) => {
		const method = url.split('/').at(-1)!;
		const body = JSON.parse(String(init.body));
		const ok = (result: unknown) => Response.json({ ok: true, result });
		if (method === 'getMe') return ok({ id: 1, username: 'mobbot' });
		if (method === 'getWebhookInfo') return ok({ url: '' });
		if (method === 'getUpdates') {
			polls++;
			if (polls === 1) return ok([
				{ update_id: 5, message: { message_id: 1, text: 'hello', from: { id: 7 }, chat: { id: 7, type: 'private' } } },
				{ update_id: 6, message: { message_id: 2, text: 'stranger', from: { id: 8 }, chat: { id: 8, type: 'private' } } },
				{ update_id: 7, message: { message_id: 3, photo: [{}], from: { id: 7 }, chat: { id: 7, type: 'private' } } },
			]);
			expect(body.offset).toBe(8);
			await new Promise(resolve => init.signal!.addEventListener('abort', resolve));
			throw init.signal!.reason;
		}
		if (method === 'sendMessage') sent.push(body);
		return ok(true);
	}) as unknown as typeof fetch;
	const statuses: string[] = [];
	const loop = s.loop(new Bot(config, fetcher), stop.signal, t => statuses.push(t));
	for (const deadline = Date.now() + 10_000; sent.length < 2 && Date.now() < deadline;) await Bun.sleep(20);
	stop.abort();
	await loop;
	expect(statuses[0]).toBe('Connected · polling private messages');
	const texts = sent.map(m => m.text as string);
	expect(texts.some(t => t.includes('Received: hello'))).toBe(true);
	expect(texts.some(t => t.startsWith('Mob reads only text'))).toBe(true);
	expect(texts.some(t => t.includes('stranger'))).toBe(false);
	expect(s.store.setting<number>('telegram-offset:1')).toBe(8);
	expect(s.store.delivery('tg:1:5')?.state).toBe('sent');
});

test('management buttons page beyond completion limits and confirm deletions', async () => {
	const s = service();
	const c = s.store.create();
	for (let i = 0; i < 25; i++) s.store.saveFact(newID(), c.id, `Fact ${i}`, true);
	const seen: string[] = [];
	let sent = '/memories';
	for (;;) {
		const [reply, rows] = await s.present(config, 'bot', sent, { text: '' });
		expect(reply.text).toContain('of 25');
		const flat = rows.flat();
		seen.push(...flat.filter(b => b.callback_data.startsWith('/_confirm /forget ') && !b.callback_data.endsWith(' all')).map(b => b.callback_data));
		const next = flat.find(b => b.text === 'Next');
		if (!next) break;
		sent = s.command(next.callback_data);
	}
	expect(new Set(seen).size).toBe(25);
	const [confirmation, rows] = await s.present(config, 'bot', seen[0]!, { text: '' });
	expect(confirmation.text).toContain('Fact 0');
	expect(s.store.facts()).toHaveLength(25);
	expect(rows[0]![0]!.callback_data).toBe(seen[0]!.replace('/_confirm ', ''));
	await s.reply(config, 'bot', newID(), rows[0]![0]!.callback_data, signal());
	expect(s.store.facts()).toHaveLength(24);
	const [, refreshed] = await s.present(config, 'bot', '/forget x', { text: 'Gone' });
	expect(refreshed.flat().some(b => b.callback_data === '/memories')).toBe(true);
});

test('conversation picker reaches conversations after the first twenty', async () => {
	const s = service();
	for (let i = 0; i < 25; i++) { const c = s.store.create(); s.store.command(c.id, newID(), 'hello', 'world'); s.store.rename(c.id, `Conversation ${i}`); }
	const [, rows] = await s.present(config, 'bot', '/_page list 24', { text: '' });
	expect(rows.flat().filter(b => b.callback_data.startsWith('/open '))).toHaveLength(1);
	expect(rows.flat().some(b => b.text === 'Previous')).toBe(true);
	expect(rows.flat().some(b => b.text === 'Next')).toBe(false);
});

test('typed and tapped management menus do not start model turns', async () => {
	const s = service();
	const sent: { text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
	const bot = new Bot(config, (async (_url, init) => {
		sent.push(JSON.parse(String(init?.body)));
		return Response.json({ ok: true, result: true });
	}) as typeof fetch);
	for (const [i, text] of ['/_page memories 0', '/_confirm /forget all', '/_more'].entries()) {
		await s.handle(bot, '1', { update_id: i + 100, message: { text, tap: true, from: { id: 7 }, chat: { id: 7, type: 'private' } } }, signal());
		expect(await s.reply(config, '1', newID(), text, signal())).not.toContain('Received:');
		await s.handle(bot, '1', { update_id: i + 200, message: { text, from: { id: 7 }, chat: { id: 7, type: 'private' } } }, signal());
	}
	expect(s.store.list(true)).toEqual([]);
	expect(sent.some(m => m.text?.includes('Saved memories'))).toBe(true);
	expect(sent.some(m => m.reply_markup?.inline_keyboard.flat().some(b => b.callback_data === '/forget all'))).toBe(true);
});


test('model menus query the provider once per request', async () => {
	let calls = 0;
	const store = new Store(openBun(':memory:')).open();
	const s = new Service(store, new ConversationService(store, { ...models, list: async () => { calls++; return []; } }));
	for (const text of ['/models', '/model', '/_page models 0']) {
		calls = 0;
		expect(await s.reply(config, 'bot', newID(), text, signal())).toContain('Choose a model');
		expect(calls).toBe(1);
	}
	expect(store.list(true)).toEqual([]);
	store.close();
});

test('local menu replies release the next update before the previous send finishes', async () => {
	const s = service();
	const stop = new AbortController();
	let release!: () => void;
	const sending = new Promise<void>(resolve => { release = resolve; });
	let polls = 0, sent = 0;
	const bot = new Bot(config, (async (url, init) => {
		const method = String(url).split('/').at(-1);
		const ok = (result: unknown) => Response.json({ ok: true, result });
		if (method === 'getMe') return ok({ id: 1 });
		if (method === 'getWebhookInfo') return ok({ url: '' });
		if (method === 'getUpdates') {
			if (!polls++) return ok([1, 2].map(update_id => ({ update_id, message: {
				text: '/_more', tap: true, from: { id: 7 }, chat: { id: 7, type: 'private' },
			} })));
			if (!init?.signal?.aborted) await new Promise(resolve => init?.signal?.addEventListener('abort', resolve, { once: true }));
			throw stop.signal.reason;
		}
		if (method === 'sendMessage' && ++sent === 1) await sending;
		return ok(true);
	}) as typeof fetch);
	const loop = s.loop(bot, stop.signal, () => {});
	let beforeRelease = 0;
	try {
		for (const deadline = Date.now() + 2000; sent < 2 && Date.now() < deadline;) await Bun.sleep(10);
		beforeRelease = sent;
	} finally {
		release();
		stop.abort();
		await loop;
	}
	expect(beforeRelease).toBe(2);
});
