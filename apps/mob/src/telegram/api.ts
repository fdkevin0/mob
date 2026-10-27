// The Telegram Bot API, as much as Mob uses.
import { rememberAlways, type PendingApproval } from '@mob/core';
import { chunks, chunkLimit } from './format';

export type Config = { enabled: boolean; token?: string; hasToken?: boolean; userId: number };

export const defaults = (): Config => ({ enabled: false, token: '', userId: 0 });

const tokenPattern = /^[0-9]+:[a-zA-Z0-9_-]+$/;

export function validate(c: Config) {
	if (c.enabled && (!tokenPattern.test(c.token ?? '') || c.userId <= 0)) throw new Error('Telegram: Bot Token and allowed user ID are required');
}

export const publicView = (c: Config): Config => { const p: Config = { ...c, hasToken: !!c.token }; delete p.token; return p; };

/** APIError is a request the Bot API refused. */
export class APIError extends Error {
	constructor(readonly status: number, readonly code: number) {
		super(`Telegram HTTP ${status} / error ${code}; check token, webhook, bot permissions or another polling client`);
	}
}

/** rejected reports whether the Bot API refused the request as malformed, so it surely did not act on it. */
export const rejected = (err: unknown) => err instanceof APIError && err.code === 400;

export type Button = { text: string; callback_data: string };
export type Keyboard = { inline_keyboard: Button[][] };

export type Message = {
	message_id?: number;
	text?: string;
	/** caption is the text sent with a photo, file or other media. */
	caption?: string;
	/** media is set when the message carries something other than text. */
	media?: boolean;
	/** tap says the message stands for a tap on a button, whose data is text. */
	tap?: boolean;
	/** buttons, for a tap, is the message holding them. */
	buttons?: Shown;
	from: { id: number };
	chat: { id: number; type: string };
	[key: string]: unknown;
};

export type Update = {
	update_id: number;
	message?: Message;
	callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number; chat: { id: number }; reply_markup?: Keyboard } };
	stopped_message_generation?: { chat: { id: number }; draft_id: number };
};

/** Shown is a message's buttons as a tap saw them. */
export type Shown = { chat: number; message: number; keyboard: Keyboard };

const mediaKeys = ['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'animation', 'sticker', 'location', 'contact'];

export class Bot {
	constructor(readonly config: Config, readonly fetcher: typeof fetch = fetch) {}

	async call<T = unknown>(method: string, input?: unknown, signal?: AbortSignal): Promise<T> {
		let res: Response;
		try {
			res = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/${method}`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input ?? null), redirect: 'manual',
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
			});
		} catch (err) {
			if (signal?.aborted) throw signal.reason;
			throw new Error('Telegram connection failed');
		}
		let reply: { ok?: boolean; result?: T; error_code?: number };
		try {
			const text = await res.text();
			if (text.length > 2 << 20) throw new Error();
			reply = JSON.parse(text);
		} catch { throw new Error('invalid Telegram response'); }
		if (!reply.ok) throw new APIError(res.status, reply.error_code ?? 0);
		return reply.result as T;
	}

	async test(signal?: AbortSignal) {
		const me = await this.call<{ id: number; username: string }>('getMe', undefined, signal);
		const hook = await this.call<{ url: string }>('getWebhookInfo', undefined, signal);
		if (hook.url) throw new Error('Telegram bot has an active webhook; remove it in the existing deployment before enabling local polling');
		return { id: me.id, username: me.username };
	}

	async updates(offset: number, signal?: AbortSignal) {
		const list = await this.call<Update[]>('getUpdates', { offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query', 'stopped_message_generation'] }, signal);
		// Whether a message carries media is noted without keeping it.
		for (const u of list) if (u.message) u.message.media = mediaKeys.some(k => u.message![k] !== undefined);
		return list;
	}

	/**
	 * tapped makes the owner's tap on a button the private message it stands
	 * for: the command, or the token of a command, its data holds. acknowledge
	 * answers the tap, best effort; it is unset for a tap that is not the owner's.
	 */
	tapped(u: Update): [Update, ((signal: AbortSignal) => Promise<void>) | undefined] {
		const q = u.callback_query;
		if (!q || q.from.id !== this.config.userId) return [u, undefined];
		// An unanswered tap only keeps its spinner a little longer.
		const acknowledge = (signal: AbortSignal) => this.call('answerCallbackQuery', { callback_query_id: q.id }, signal).then(() => {}, () => {});
		const data = q.data ?? '';
		if (!data.startsWith('/') && !data.startsWith('#')) return [u, acknowledge];
		const m: Message = { text: data, tap: true, from: { id: this.config.userId }, chat: { id: this.config.userId, type: 'private' } };
		if (q.message?.reply_markup) m.buttons = { chat: q.message.chat.id, message: q.message.message_id, keyboard: q.message.reply_markup };
		return [{ ...u, message: m }, acknowledge];
	}

	/** send sends Markdown formatted as Telegram shows it, with rows of buttons under its last message; one Telegram cannot format goes as plain text. */
	async send(chatId: number, text: string, rows: Button[][] = [], signal?: AbortSignal) {
		const list = chunks(text, chunkLimit);
		for (const [i, part] of list.entries()) {
			const message: Record<string, unknown> = { chat_id: chatId, text: part.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
			if (i === list.length - 1 && rows.length) message.reply_markup = { inline_keyboard: rows };
			try { await this.call('sendMessage', message, signal); } catch (err) {
				if (!rejected(err)) throw err;
				delete message.parse_mode;
				message.text = part.plain;
				await this.call('sendMessage', message, signal);
			}
		}
	}

	/** draft shows that a reply is being written, with a button to stop it, until a message is sent or about 30 seconds pass. */
	draft(chatId: number, draftId: number, signal?: AbortSignal) {
		return this.call('sendMessageDraft', { chat_id: chatId, draft_id: draftId, text: '', can_stop: true }, signal);
	}

	/** typing shows that the bot is typing for about five seconds. */
	typing(chatId: number, signal?: AbortSignal) { return this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, signal); }
}

/** decided is the keyboard less the rows of buttons for the decided approvals. */
export function decided(k: Keyboard, ids: Set<string>): Keyboard {
	return { inline_keyboard: k.inline_keyboard.filter(row => { const f = row[0]?.callback_data.split(/\s+/).filter(Boolean) ?? []; return f.length < 2 || !ids.has(f[1]!); }) };
}

/** buttons keeps one-time decisions separate from remembered approval scopes. */
export function buttons(approvals: PendingApproval[]): Button[][] {
	return approvals.flatMap(a => {
		const label = approvals.length > 1 ? ' ' + a.tool : '';
		return [
			[{ text: 'Approve' + label, callback_data: '/approve ' + a.id }, { text: 'Deny' + label, callback_data: '/deny ' + a.id }],
			[{ text: 'Allow in conversation' + label, callback_data: `/approve ${a.id} conversation` }, { text: 'Always allow' + label, callback_data: `/approve ${a.id} ${rememberAlways}` }],
		];
	});
}
