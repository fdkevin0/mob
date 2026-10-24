// WeChat iLink: Mob answers the allowed users' messages to a WeChat bot.
import { Bridge, clientWeChat, CommandError, describeApproval, isAbort, rememberAlways, rememberConversation, ReplyError, useText, type Answer, type ChannelMessage, type ConversationService, type PendingApproval, type Reply, type Store, type Texts } from '@mob/core';
import { allowed, Client, isOwner, type Config, type Inbound } from './client';

/** approvalPrompt shows what each requested call would do and how to answer, given how many requests are pending. */
function approvalPrompt(approvals: PendingApproval[], pending: number) {
	let b = approvals.map(a => `\n\n⚠️ 【操作审批】${describeApproval(a.tool, a.input)[0]}\n审批 ID: ${a.id}`).join('');
	b += pending > 1
		? '\n\n有多个待审批请求，请回复「批准 ID」或「拒绝 ID 原因」，原因可省略；「批准 ID 总是」以后同类请求不再询问。'
		: '\n\n允许请回复「批准」，拒绝请回复「拒绝」，可在后面写上原因。回复「批准 总是」以后同类请求不再询问。';
	return b;
}

export const texts: Texts = {
	help: 'Mob 已连接，直接发消息即可聊天。这台电脑需要保持运行。',
	approvals: approvalPrompt,
	decided: a => a.approved ? `已批准操作（ID: ${a.id}）。` + (a.remember ? '已记住这个决定，以后同类请求不再询问；可回复 /grants 查看，/revoke 撤销。' : '') : `已拒绝操作（ID: ${a.id}）。`,
	stale: id => `⚠️ 审批指令无效或该审批已过期（ID: ${id}）`,
	failed: err => err instanceof CommandError ? '\n⚠️ ' + err.message : isAbort(err) ? '\n（对话已取消）' : `\n⚠️ Mob 出错：${err.message}。完整结果可在桌面端或终端查看。`,
	unsupported: '这个命令需要在桌面端或终端使用。',
	empty: '（无回复内容）',
	used: used => `\n\n（使用了 ${used.map(useText).join('、')}，详情见桌面端会话。）`,
};

/**
 * parseApproval reads "批准 [ID] [总是|本会话]" or "拒绝 [ID] [原因]". Without
 * an ID it answers the only pending request; a denial's other text is its reason.
 */
export function parseApproval(text: string): Answer | undefined {
	const lower = text.toLowerCase();
	const prefixes: [string, boolean][] = [['批准', true], ['approve', true], ['允许', true], ['拒绝', false], ['reject', false], ['否决', false]];
	const remember: Record<string, string> = { '': '', 总是: rememberAlways, always: rememberAlways, 本会话: rememberConversation, conversation: rememberConversation };
	for (const [prefix, approved] of prefixes) {
		if (!lower.startsWith(prefix)) continue;
		const answer: Answer = { id: '', approved };
		let rest = text.slice(prefix.length).trim();
		const first = rest.split(/\s+/).filter(Boolean)[0];
		if (first?.length === 32) { answer.id = first; rest = rest.slice(first.length).trim(); }
		if (!approved) { answer.reason = rest; return answer; }
		const how = remember[rest.toLowerCase()];
		// Not an ID nor a known word: report it as a malformed ID.
		if (how === undefined) answer.id = rest;
		answer.remember = how ?? '';
		return answer;
	}
	return undefined;
}

export class Service {
	readonly bridge: Bridge;
	constructor(readonly store: Store, readonly conversation: ConversationService) {
		this.bridge = new Bridge('WeChat iLink', clientWeChat, store, conversation, texts);
	}

	/** message is what sender wrote, as the bridge reads it; id is empty for a message not delivered from WeChat. */
	private message(c: Config, id: string, sender: string, text: string): ChannelMessage {
		return { id: id || undefined, key: 'wechat-ilink-conv:' + sender, owner: isOwner(c, sender), text: text.trim() };
	}

	/** process answers a message from sender, as the web UI sends one. */
	async process(c: Config, sender: string, text: string, signal: AbortSignal) {
		return (await this.answer(c, sender, this.message(c, '', sender, text), signal)).text;
	}

	/** answer refuses senders not allowed to use the bot and reads 批准 and 拒绝 as /approve and /deny. */
	private async answer(c: Config, sender: string, m: ChannelMessage, signal: AbortSignal): Promise<Reply> {
		if (!allowed(c, sender)) return { text: '⚠️ 抱歉，当前微信账号未在授权白名单内。请在 Mob 桌面端或设置中添加您的用户 ID 并确认授权。' };
		const answer = parseApproval(m.text);
		if (answer) {
			const [command, refusal] = this.decision(m.key, answer);
			if (!command) return { text: refusal };
			m.text = command;
		}
		return this.bridge.answer(m, signal);
	}

	/** decision is the command for answer, or why there is none. */
	private decision(key: string, answer: Answer): [string, string] {
		if (!answer.id) {
			let id = '';
			try { id = this.store.setting<string>(key) ?? ''; } catch { /* no conversation */ }
			const pending = this.conversation.pending(id);
			if (!pending.length) return ['', '当前没有待审批的请求。'];
			if (pending.length > 1) return ['', '有多个待审批请求，请回复「批准 ID」或「拒绝 ID」：' + pending.map(p => `\n${p.tool}: ${p.id}`).join('')];
			answer.id = pending[0]!.id;
		}
		if (answer.id.length !== 32) return ['', `⚠️ 审批 ID 格式不正确（需为 32 位字符，当前: ${answer.id}）`];
		// A command is one line; a reason on several would be sent as chat.
		if (!answer.approved) return [`/deny ${answer.id} ${(answer.reason ?? '').split(/\s+/).filter(Boolean).join(' ')}`.trim(), ''];
		return [`/approve ${answer.id} ${answer.remember ?? ''}`.trim(), ''];
	}

	/** loop long-polls getupdates until signal aborts. */
	async loop(client: Client, signal: AbortSignal, status: (s: string) => void) {
		const c = client.config;
		if (!c.enabled || !c.botToken) { status('Disabled or missing Bot Token'); return; }
		const cursorKey = 'wechat-ilink-cursor:' + (c.botId ?? '');
		let cursor: string;
		try { cursor = this.store.setting<string>(cursorKey) ?? ''; } catch { status('Cannot load WeChat update cursor'); return; }
		status('Connected · Polling WeChat messages');
		while (!signal.aborted) {
			let res;
			try { res = await client.updates(cursor, signal); } catch (err) {
				if (signal.aborted) return;
				status('Polling error: ' + (err as Error).message);
				await new Promise(resolve => { const t = setTimeout(resolve, 5000); signal.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true }); });
				continue;
			}
			status('Active · Polling WeChat messages');
			for (const msg of res.msgs ?? []) {
				if (signal.aborted) return;
				const text = (msg.item_list ?? []).filter(i => i.type === 1 && i.text_item).map(i => i.text_item!.text).join('');
				if (!text.trim() || !msg.from_user_id) continue;
				const id = msg.msg_id ? `wx:${c.botId ?? ''}:${msg.msg_id}` : '';
				try { await this.deliver(c, client, msg, id, text, signal); } catch (err) {
					if (signal.aborted) return;
					status((err as Error).message);
					let accepted = false;
					try { accepted = !!id && this.store.deliveryAccepted(id); } catch { /* stops below */ }
					if (!accepted) return;
				}
			}
			if (res.get_updates_buf) {
				try { this.store.saveSetting(cursorKey, res.get_updates_buf); } catch { status('Cannot save WeChat update cursor'); return; }
				cursor = res.get_updates_buf;
			}
		}
	}

	/** deliver answers msg and sends the reply once. A message without an ID cannot be recorded, so it is answered as it comes. */
	private async deliver(c: Config, client: Client, msg: Inbound, id: string, text: string, signal: AbortSignal) {
		const m = this.message(c, id, msg.from_user_id!, text);
		const send = (r: Reply, signal: AbortSignal) => client.send(msg.from_user_id!, msg.context_token ?? '', r.text, signal);
		// Typing is only a hint; the reply goes out without it.
		await client.typing(msg.from_user_id!, msg.context_token ?? '', signal).catch(() => {});
		const answer = (signal: AbortSignal) => this.answer(c, msg.from_user_id!, m, signal);
		if (id) return this.bridge.deliver(id, answer, send, signal);
		let reply: Reply, failure: unknown;
		try { reply = await answer(signal); } catch (err) { failure = err; reply = err instanceof ReplyError ? err.reply : { text: '' }; }
		await send(reply, signal);
		if (failure) throw failure;
	}
}
