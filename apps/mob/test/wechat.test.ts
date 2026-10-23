import { expect, test } from 'bun:test';
import { ConversationService, DemoModel, Store, type Models } from '@mob/core';
import { openBun } from '@mob/core/sqlite/bun';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Config } from '../src/wechat/client';
import { parseApproval, Service } from '../src/wechat/service';

const models: Models = { default: () => 'demo/echo', resolve: () => new DemoModel(), setDefault: () => new DemoModel().ref, list: async () => [] };
const service = () => {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-wx-')), 'mob.sqlite'))).open();
	return new Service(store, new ConversationService(store, models));
};
const config: Config = { enabled: true, botToken: 't', botId: 'bot', allowedUsers: ['owner', 'guest'] };
const signal = () => new AbortController().signal;
const id = 'a'.repeat(32);

test('approvals in words', () => {
	expect(parseApproval('批准')).toEqual({ id: '', approved: true, remember: '' });
	expect(parseApproval('批准 总是')).toEqual({ id: '', approved: true, remember: 'always' });
	expect(parseApproval(`Approve ${id} conversation`)).toEqual({ id, approved: true, remember: 'conversation' });
	expect(parseApproval(`拒绝 ${id} 太贵了`)).toEqual({ id, approved: false, reason: '太贵了' });
	expect(parseApproval('批准 什么')).toEqual({ id: '什么', approved: true, remember: '' });
	expect(parseApproval('你好')).toBeUndefined();
});

test('the owner approves in words; strangers are refused', async () => {
	const s = service();
	expect(await s.process(config, 'stranger', 'hi', signal())).toContain('授权白名单');
	expect(await s.process(config, 'owner', '批准', signal())).toBe('当前没有待审批的请求。');
	const asked = await s.process(config, 'owner', '/remember 喝茶', signal());
	expect(asked).toContain('【操作审批】');
	expect(asked).toContain('允许请回复「批准」');
	const done = await s.process(config, 'owner', '批准', signal());
	expect(done).toStartWith('已批准操作');
	expect(s.store.memories('', true)).toContain('喝茶');
	expect(await s.process(config, 'owner', '批准 abc', signal())).toContain('审批 ID 格式不正确');
});

test('the loop answers each message once', async () => {
	const s = service();
	const sent: string[] = [];
	let polls = 0;
	const stop = new AbortController();
	const fetcher = (async (url: string, init: RequestInit) => {
		const path = new URL(url).pathname;
		if (path.endsWith('/getupdates')) {
			polls++;
			const body = JSON.parse(String(init.body));
			if (polls === 1) return Response.json({ ret: 0, get_updates_buf: 'c1', msgs: [{ msg_id: 'm1', from_user_id: 'owner', context_token: 'ct', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] });
			if (polls === 2) return Response.json({ ret: 0, get_updates_buf: 'c2', msgs: [{ msg_id: 'm1', from_user_id: 'owner', context_token: 'ct', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] });
			expect(body.get_updates_buf).toBe('c2');
			await new Promise(r => init.signal!.addEventListener('abort', r));
			throw init.signal!.reason;
		}
		if (path.endsWith('/sendmessage')) sent.push(JSON.parse(String(init.body)).msg.item_list[0].text_item.text);
		return Response.json({ ret: 0 });
	}) as unknown as typeof fetch;
	const loop = s.loop(new Client(config, fetcher), stop.signal, () => {});
	for (const deadline = Date.now() + 10_000; polls < 3 && Date.now() < deadline;) await Bun.sleep(20);
	stop.abort();
	await loop;
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('Received: hello');
	expect(s.store.setting<string>('wechat-ilink-cursor:bot')).toBe('c2');
});
