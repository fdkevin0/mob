// The Telegram channel: Mob answers its owner's private messages to a bot,
// polling the Bot API, with buttons standing in for typed commands.
import { Bridge, clientTelegram, ReplyError, describeApproval, NotFound, type ChannelMessage, type CommandSpec, type ConversationService, type Notice, type PendingApproval, type Reply, type Store, type Suggestion, type Texts, useText } from '@mob/core';
import { Bot, buttons, decided, type Button, type Config, type Keyboard, type Shown, type Update } from './api';

/** placeholderDelay is how long a reply may take before Mob shows that it is being written. */
export let placeholderDelay = 1000;
/** draftRefresh and typingRefresh are how often the placeholder is shown again; a draft lasts about 30 seconds and a typing status about five. */
let draftRefresh = 20_000, typingRefresh = 4000;
export const setPlaceholderTimings = (t: { delay?: number; draft?: number; typing?: number }) => { placeholderDelay = t.delay ?? placeholderDelay; draftRefresh = t.draft ?? draftRefresh; typingRefresh = t.typing ?? typingRefresh; };

/** menuButtons are what /help and /start offer. */
export const menuButtons: Button[][] = [
	[{ text: 'New conversation', callback_data: '/new' }, { text: 'Conversations', callback_data: '/list' }],
	[{ text: 'Model', callback_data: '/model' }, { text: 'Compact', callback_data: '/compact' }],
	[{ text: 'Remembered approvals', callback_data: '/grants' }],
];
const stopButton: Button[][] = [[{ text: 'Stop', callback_data: '/stop' }]];

/** picks names, for a command whose reply offers things to pick from, the command a button for each of them sends. */
const picks: Record<string, string> = { '/list': '/open', '/open': '/open', '/model': '/model', '/models': '/model', '/grants': '/revoke', '/revoke': '/revoke' };

const pickConversation = 'Conversations, most recent first. Tap one to continue it here; ✓ marks the current one.';
export const expired = 'That button has expired. Here is the menu again.';
/** callbackLimit is the most bytes a button's data may hold; keyboardLimit the most buttons a message may hold; labelLimit what a phone shows on one line. */
const callbackLimit = 64, keyboardLimit = 100, labelLimit = 48;
export const mediaUnsupported = 'Mob reads only text here for now; send photos, files and voice notes from the desktop app, or describe them in a message.';

/** fence is text as a Markdown code block, fenced so nothing in it ends the block. */
export function fence(text: string) {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(r => r.length));
	const f = '`'.repeat(Math.max(3, longest + 1));
	return `${f}\n${text}\n${f}`;
}

const approval = (a: PendingApproval) => `\n\n**Approval needed**\n${fence(describeApproval(a.tool, a.input)[0])}\nID: \`${a.id}\``;

/** decideHint tells the owner how to answer, given how many requests are pending. */
const decideHint = (pending: number) => pending > 1
	? 'Tap a button to decide, or reply /deny ID with a reason. Always allow stops asking for calls like this; Remembered approvals in the menu lists them.'
	: 'Tap a button to decide, or reply /deny with a reason. Always allow stops asking for calls like this; Remembered approvals in the menu lists them.';

export const texts: Texts = {
	help: 'Mob is connected. Send a message to chat, or tap a button below; every command is also in the / menu. This computer must remain running.',
	approvals: (approvals, pending) => approvals.map(approval).join('') + '\n\n' + decideHint(pending),
	busy: 'Still working on your last message. Tap Stop to stop it, then send this again.',
	stopped: 'Stopped.',
	stale: id => `Approval ${id} is unknown, expired, or already decided.`,
	failed: err => `\nMob: ${err.message}. Open the desktop/TUI for the saved result.`,
	unsupported: 'That command needs the desktop or terminal app.',
	empty: 'Done. Open the local conversation for details.',
	used: used => `\n\n(Used ${used.map(useText).join(', ')}. Details are in the local conversation.)`,
};

/** menu is the commands as setMyCommands accepts them; names Telegram rejects are left out. */
export function menu(specs: CommandSpec[]) {
	return specs.filter(s => /^[a-z0-9_]{1,32}$/.test(s.name) && s.summary.trim()).map(s => ({ command: s.name, description: [...s.summary.trim()].slice(0, 256).join('') }));
}

function clip(label: string) {
	label = label.split(/\s+/).filter(Boolean).join(' ');
	const c = [...label];
	return c.length > labelLimit ? c.slice(0, labelLimit - 1).join('') + '…' : label;
}

/**
 * picked reports whether text, sent by a tap on one of the buttons in k,
 * picked one of a list's choices, which then no longer stands. New
 * conversation under the conversation list is such a choice; the menu's is not.
 */
export function picked(text: string, k: Keyboard) {
	const i = text.indexOf(' ');
	const name = i < 0 ? text : text.slice(0, i), rest = i < 0 ? '' : text.slice(i + 1);
	if (picks[name] && rest.trim()) return true;
	return text === '/new' && k.inline_keyboard.some(row => row.some(b => b.callback_data.startsWith('/open ')));
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<boolean>(resolve => {
	if (signal.aborted) return resolve(false);
	const done = () => { clearTimeout(t); resolve(!signal.aborted); };
	const t = setTimeout(done, ms);
	signal.addEventListener('abort', done, { once: true });
});

const messageId = (botId: string, u: Update) => `tg:${botId}:${u.update_id}`;
const conversationKey = (botId: string, c: Config) => `telegram-conversation:${botId}:${c.userId}`;

export class Service {
	readonly bridge: Bridge;
	/** drafts numbers the drafts shown from the time, so a tap on a draft shown before a restart matches none since. */
	private drafts = Date.now();
	/** stops stops the turn each draft shows, for a tap on its stop button. */
	private stops = new Map<number, () => void>();
	/** callbacks holds the commands of buttons too long for Telegram to carry, by the token each carries instead. */
	private callbacks = new Map<string, string>();
	private tokens = 0;
	/** decisions holds, per message, the buttons first seen and the approvals decided since; edits orders changes to them. */
	private decisions = new Map<string, { keyboard: Keyboard; ids: Set<string> }>();
	private edits: Promise<unknown> = Promise.resolve();

	constructor(readonly store: Store, readonly conversation: ConversationService) {
		this.bridge = new Bridge('Telegram', clientTelegram, store, conversation, texts, 32000);
	}

	/** publishCommands shows the registry's Telegram commands in the owner's chat menu, the only chat the bot answers. */
	publishCommands(bot: Bot, signal: AbortSignal) {
		return bot.call('setMyCommands', { commands: menu(this.conversation.commands.specs(clientTelegram)), scope: { type: 'chat', chat_id: bot.config.userId } }, signal);
	}

	/**
	 * loop answers the owner's messages until signal aborts. Replies run
	 * alongside polling, so the owner can stop one or decide an approval while
	 * another is being written.
	 */
	async loop(bot: Bot, signal: AbortSignal, status: (s: string) => void) {
		const c = bot.config;
		const replies = new Set<Promise<unknown>>();
		const go = (p: Promise<unknown>) => { const q = p.catch(() => {}).finally(() => replies.delete(q)); replies.add(q); };
		// previous resolves once the message before has started; each message waits for it, so a message after /new goes to the new conversation.
		let previous: Promise<void> = Promise.resolve();
		const botId = c.token!.split(':')[0]!;
		// Notices reach the owner while Mob polls; a reply to a message sent here already says what its notice would.
		const unsubscribe = this.conversation.notices(n => { if (n.channel !== this.bridge.name) go(this.announce(bot, n, signal)); });
		const offsetKey = 'telegram-offset:' + botId;
		let offset: number, published = false;
		try {
			try { offset = this.store.setting<number>(offsetKey) ?? 0; } catch { status('Cannot load Telegram update offset'); return; }
			outer: while (!signal.aborted) {
				try { await bot.test(signal); } catch (err) {
					if (signal.aborted) return;
					status((err as Error).message);
					if (!await sleep(10_000, signal)) return;
					continue;
				}
				status('Connected · polling private messages');
				if (!published) {
					// The menu is a convenience; polling goes on without it and the next connection retries.
					try { await this.publishCommands(bot, signal); published = true; } catch (err) {
						if (signal.aborted) return;
						status('Connected · polling private messages · command menu not updated: ' + (err as Error).message);
					}
				}
				while (!signal.aborted) {
					let updates: Update[];
					try { updates = await bot.updates(offset, signal); } catch (err) {
						if (signal.aborted) return;
						status((err as Error).message);
						if (!await sleep(10_000, signal)) return;
						continue outer;
					}
					for (let update of updates) {
						if (signal.aborted) return;
						if (update.update_id < offset) continue;
						let acknowledge;
						[update, acknowledge] = bot.tapped(update);
						if (acknowledge) go(acknowledge(signal));
						const stopped = update.stopped_message_generation;
						if (stopped && stopped.chat.id === c.userId) this.stops.get(stopped.draft_id)?.();
						const m = update.message;
						if (m && m.from.id === c.userId && m.chat.id === c.userId && m.chat.type === 'private') {
							if (m.tap) {
								m.text = this.command(m.text ?? '');
								if (!m.text) go(bot.send(m.chat.id, expired, menuButtons, signal));
							} else if (!m.text && m.caption) m.text = m.caption;
							const id = messageId(botId, update);
							if (!m.text) {
								// Best effort: the owner can send it again as text.
								if (m.media) go(bot.send(m.chat.id, mediaUnsupported, [], signal));
							} else {
								let fresh = false;
								try { fresh = this.bridge.accept(id); } catch (err) {
									status((err as Error).message);
									let accepted = false;
									try { accepted = this.store.deliveryAccepted(id); } catch { /* stops below */ }
									if (!accepted) return;
								}
								if (fresh) {
									let start!: () => void;
									const started = new Promise<void>(resolve => { start = resolve; });
									const before = previous;
									const u = update;
									go((async () => {
										try {
											await Promise.race([before, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
											await this.finish(bot, botId, u, () => start(), signal);
										} catch (err) { if (!signal.aborted) status((err as Error).message); } finally { start(); }
									})());
									previous = started;
								}
							}
						}
						if (signal.aborted) return;
						offset = update.update_id + 1;
						try { this.store.saveSetting(offsetKey, offset); } catch { status('Cannot save Telegram update offset; polling stopped'); return; }
					}
				}
			}
		} finally {
			unsubscribe();
			await Promise.all(replies);
		}
	}

	/** message is the owner's message in update u, as the bridge reads it. */
	private message(c: Config, botId: string, u: Update): ChannelMessage {
		const text = u.message!.text === '/start' ? '/help' : u.message!.text ?? '';
		// The bot answers only its configured user, who owns this Mob.
		return { id: messageId(botId, u), key: conversationKey(botId, c), owner: true, text };
	}

	/** handle answers the owner's message in update u and sends the reply once. */
	async handle(bot: Bot, botId: string, u: Update, signal: AbortSignal) {
		if (this.bridge.accept(messageId(botId, u))) await this.finish(bot, botId, u, undefined, signal);
	}

	/** finish answers a message the bridge accepted, showing that the reply is being written until it is sent. */
	private finish(bot: Bot, botId: string, u: Update, started: (() => void) | undefined, signal: AbortSignal) {
		const m = this.message(bot.config, botId, u);
		const draft = ++this.drafts;
		m.started = stop => { if (stop) this.stops.set(draft, stop); started?.(); };
		let rows: Button[][] = [];
		const answer = async (signal: AbortSignal): Promise<Reply> => {
			// The placeholder's requests end with the answer, so none holds back the reply.
			const placeholding = new AbortController();
			const shown = this.placeholder(bot, u.message!.chat.id, draft, AbortSignal.any([signal, placeholding.signal]));
			try {
				let r: Reply;
				try {
					this.bindApproval(m);
					r = await this.bridge.answer(m, signal);
				} catch (err) {
					if (err instanceof ReplyError) { let p; [p, rows] = await this.present(bot.config, botId, m.text, err.reply); Object.assign(err.reply, p); }
					throw err;
				}
				[r, rows] = await this.present(bot.config, botId, m.text, r);
				return r;
			} finally {
				this.stops.delete(draft);
				placeholding.abort();
				await shown;
			}
		};
		return this.bridge.finish(m.id!, answer, async (r, signal) => {
			let err: unknown;
			try { await bot.send(u.message!.chat.id, r.text, [...buttons(r.approvals ?? []), ...rows], signal); } catch (e) { err = e; }
			const tap = u.message!.buttons;
			if (tap) {
				if (r.settled) await this.settle(bot, tap, r.settled, signal);
				// Best effort: a stale choice only does what it says again.
				else if (picked(u.message!.text ?? '', tap.keyboard) && r.text !== texts.busy) await bot.call('editMessageReplyMarkup', { chat_id: tap.chat, message_id: tap.message, reply_markup: { inline_keyboard: [] } }, signal).catch(() => {});
			}
			if (err) throw err;
		}, signal);
	}

	/** bindApproval sends a decision to the approval's conversation, which may not be the one the owner writes to here, such as a coding agent's task. */
	private bindApproval(m: ChannelMessage) {
		const fields = m.text.split(/\s+/).filter(Boolean);
		if (fields.length < 2 || (fields[0] !== '/approve' && fields[0] !== '/deny') || fields[1]!.length !== 32) return;
		try { m.conversationId = this.store.approvalConversation(fields[1]!); } catch (err) {
			if (!(err instanceof NotFound)) throw new ReplyError({ text: "Cannot load the approval's conversation." }, err);
		}
	}

	/**
	 * settle removes the buttons for approval id, which no longer waits for a
	 * decision, from the message a tap found them on, along with those for
	 * the approvals settled before. Best effort.
	 */
	private settle(bot: Bot, b: Shown, id: string, signal: AbortSignal) {
		const next = this.edits.then(async () => {
			const key = `${b.chat}:${b.message}`;
			let d = this.decisions.get(key);
			if (!d) { d = { keyboard: b.keyboard, ids: new Set() }; this.decisions.set(key, d); }
			d.ids.add(id);
			// The entry stays once every row is gone, so a late duplicate tap, which carries the keyboard as it was, cannot bring rows back.
			await bot.call('editMessageReplyMarkup', { chat_id: b.chat, message_id: b.message, reply_markup: decided(d.keyboard, d.ids) }, signal).catch(() => {});
		});
		this.edits = next.catch(() => {});
		return next;
	}

	/**
	 * placeholder shows a draft with a stop button while a reply is written,
	 * once it takes longer than placeholderDelay, until signal aborts. Where
	 * drafts are unavailable it shows the bot typing instead. Both are best effort.
	 */
	private async placeholder(bot: Bot, chatId: number, draftId: number, signal: AbortSignal) {
		let wait = placeholderDelay, typing = false;
		while (await sleep(wait, signal)) {
			if (!typing) typing = await bot.draft(chatId, draftId, signal).then(() => false, () => true);
			if (signal.aborted) return;
			if (typing) { await bot.typing(chatId, signal).catch(() => {}); wait = typingRefresh; } else wait = draftRefresh;
		}
	}

	/** reply answers text as if the owner had sent it to the bot. */
	async reply(c: Config, botId: string, requestId: string, text: string, signal: AbortSignal) {
		const m = this.message(c, botId, { update_id: 0, message: { text, from: { id: c.userId }, chat: { id: c.userId, type: 'private' } } });
		m.id = requestId;
		return (await this.present(c, botId, m.text, await this.bridge.answer(m, signal)))[0].text;
	}

	/** announce sends the owner notice n, with buttons for the approvals it says wait. */
	private announce(bot: Bot, n: Notice, signal: AbortSignal) {
		let text = n.text + (n.approvals ?? []).map(approval).join('');
		if (n.approvals?.length) text += '\n\nTap a button to decide, or reply /deny ID with a reason.';
		return bot.send(bot.config.userId, text, buttons(n.approvals ?? []), signal);
	}

	/** present is the reply to sent as the bot shows it, with the buttons that go under it. */
	async present(c: Config, botId: string, sent: string, r: Reply): Promise<[Reply, Button[][]]> {
		if (r.text === texts.busy) return [r, stopButton];
		const trimmed = sent.trim();
		const i = trimmed.indexOf(' ');
		const name = i < 0 ? trimmed : trimmed.slice(0, i), rest = i < 0 ? '' : trimmed.slice(i + 1).trim();
		// The menu replaces the command list, which stays in the / menu.
		if (name === '/help') return [{ ...r, text: texts.help! }, menuButtons];
		if (name === '/open' && rest && !r.text) return [{ ...r, text: `Switched to ${this.title(rest)}.` }, []];
		const command = picks[name];
		if (!command || (rest && (name !== '/models' || /[ \t]/.test(rest)))) return [r, []];
		const rows = await this.choices(c, botId, command, rest);
		if (command === '/open') return [{ ...r, text: pickConversation }, [...rows, menuButtons[0]!.slice(0, 1)]];
		return [r, rows];
	}

	/** choices are buttons sending command with each value the registry suggests for its argument. */
	private async choices(c: Config, botId: string, command: string, filter: string): Promise<Button[][]> {
		let current: string;
		try { current = this.store.setting<string>(conversationKey(botId, c)) ?? ''; } catch { return []; }
		let suggestions: Suggestion[];
		if (command === '/revoke') {
			// Completion keeps 20 suggestions; every remembered approval needs a button, up to the most a message can hold.
			suggestions = [{ value: 'all', label: '' }, ...this.store.grants().slice(0, keyboardLimit - 1).map(g => ({ value: g.id, label: g.tool, detail: g.scope }))];
		} else suggestions = await this.conversation.commands.complete({ client: clientTelegram, conversationId: current, text: command + ' ' + filter }, true);
		return suggestions.map(choice => {
			let label = choice.label;
			if (command === '/open' && !label.trim()) label = 'Untitled';
			else if (command === '/model' && choice.value === 'default') label = 'Follow the default model';
			else if (command === '/revoke' && choice.value === 'all') label = 'Forget all';
			else if (command === '/revoke') label = 'Forget ' + label + (choice.detail ? ' · ' + choice.detail : '');
			label = clip(label);
			if (command === '/open' && choice.value === current) label = '✓ ' + label;
			return [{ text: label, callback_data: this.callback(command + ' ' + choice.value) }];
		});
	}

	/** title is how the conversation with id is named on a button. */
	private title(id: string) {
		const c = this.store.list().find(c => c.id === id && c.title.trim());
		return c ? `“${clip(c.title)}”` : 'the conversation';
	}

	/** callback is the data of a button sending command; a command too long for Telegram is kept under a short token until Mob restarts. */
	callback(command: string) {
		if (new TextEncoder().encode(command).length <= callbackLimit) return command;
		// Tokens are numbered from the time, so a button shown before a restart matches none shown since.
		if (!this.tokens) this.tokens = Date.now();
		// Old buttons answer that they expired.
		if (this.callbacks.size >= 512) this.callbacks.clear();
		const token = '#' + (++this.tokens).toString(36);
		this.callbacks.set(token, command);
		return token;
	}

	/** command is what a tap on a button with data sends; '' for a token that has expired. */
	command(data: string) { return data.startsWith('#') ? this.callbacks.get(data) ?? '' : data; }
}
