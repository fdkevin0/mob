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
	expect(await reply('/grants')).toContain('| remember | every call | every conversation |');
	expect(await reply('/revoke all')).toContain('Forgot 1');
});

test('buttons, taps and menus', () => {
	const a = newID();
	expect(buttons([{ id: a, tool: 'remember', input: {} }])).toEqual([[{ text: 'Approve', callback_data: '/approve ' + a }, { text: 'Always allow', callback_data: `/approve ${a} always` }, { text: 'Deny', callback_data: '/deny ' + a }]]);
	const bot = new Bot(config);
	const tap = (from: number, data: string) => bot.tapped({ update_id: 9, callback_query: { id: 'q', data, from: { id: from } } } as Update);
	expect(tap(8, '/new')[1]).toBeUndefined();
	const [u, ack] = tap(7, '/new');
	expect(ack).toBeDefined();
	expect(u.message).toMatchObject({ text: '/new', tap: true, chat: { id: 7, type: 'private' } });
	expect(menu([{ name: 'ok', usage: '/ok', summary: 'Fine', clients: [] }, { name: 'Bad-Name', usage: '', summary: 'x', clients: [] }])).toEqual([{ command: 'ok', description: 'Fine' }]);
	expect(picked('/open abc', { inline_keyboard: [] })).toBe(true);
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
