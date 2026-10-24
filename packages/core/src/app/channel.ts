// What the messaging apps Mob answers in share: each message runs the command
// registry or a turn, answers in the app's own words, and is recorded so a
// restart never answers or sends it twice. A channel plugin brings only its
// transport (receiving and sending) and who is writing.
import { decide, openConversation } from '../chat/commands';
import { CommandError, type ChatRequest, type ConversationService, type PendingApproval } from '../chat/conversation';
import type { Answer } from '../chat/delegate';
import { isAbort, type Running } from '../chat/running';
import { newID, NotFound } from '../chat/sql';
import { isStaleApproval, type Store } from '../chat/store';

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Texts are what a channel says in its own words. */
export type Texts = {
	/** help comes before the command list that /help shows. */
	help?: string;
	/** approvals follows a reply whose turn requested approvals; pending is how many requests the conversation has waiting. */
	approvals: (approvals: PendingApproval[], pending: number) => string;
	/** decided, when set, comes before the reply to a decision. */
	decided?: (a: Answer) => string;
	/** stale answers a decision on an approval that is unknown, expired or already decided. */
	stale: (id: string) => string;
	/** failed follows the reply when a command or turn failed. */
	failed: (err: Error) => string;
	/** unsupported answers a command only the desktop and terminal apps can carry out. */
	unsupported: string;
	/** empty answers a turn that said nothing. */
	empty: string;
	/** used, when set, follows the reply of a turn that called tools, to say which in a line. */
	used?: (used: Use[]) => string;
	/** busy, when set, answers a message sent while the conversation's previous turn is still running. */
	busy?: string;
	/** stopped, when set, follows the reply of a turn the sender stopped. */
	stopped?: string;
};

/** Message is one message someone sent Mob in an app. */
export type Message = {
	/** id, when set, is unique and stable for the message in its app and is the turn's request ID. */
	id?: string;
	/** key is the setting naming the conversation the sender writes to. */
	key: string;
	/** conversationId binds a button to its original conversation without changing the sender's selection. */
	conversationId?: string;
	/** owner says the sender owns this Mob. */
	owner: boolean;
	text: string;
	/**
	 * started, when set, is called with a function that stops the message's
	 * turn once the turn is admitted, and with undefined once the answer is
	 * ready; a message without a turn gets only the latter. An app answering
	 * messages concurrently waits for the first call before answering the
	 * next, so they take effect in the order they were sent.
	 */
	started?: (stop?: () => void) => void;
};

/** Reply is what Mob answers a message with. */
export type Reply = {
	text: string;
	/** approvals are the requests the turn made, for apps that show buttons. */
	approvals?: PendingApproval[];
	/** settled, when the message decided an approval, is its ID once it no longer waits, for apps that remove its buttons. */
	settled?: string;
};

/** ReplyError is a failure whose reply still says what happened. */
export class ReplyError extends Error {
	constructor(readonly reply: Reply, readonly cause: unknown) { super((cause as Error)?.message ?? String(cause)); }
}

/** Use is a tool a turn called and how many times. */
export type Use = { tool: string; times: number };
export const useText = (u: Use) => u.times > 1 ? `${u.tool} ×${u.times}` : u.tool;

const errorOf = (e: unknown) => e instanceof Error ? e : new Error(String(e));

/** Bridge answers one messaging app's messages. */
export class Bridge {
	/** queue keeps messages that arrive together from each creating a conversation for the same sender. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		/** name is the app's name in errors and statuses, such as "Telegram". */
		readonly name: string,
		/** client names the app to the command registry. */
		readonly client: string,
		readonly store: Store,
		readonly conversation: ConversationService,
		readonly texts: Texts,
		/** limit, when set, ends a turn whose reply grows past it, in bytes. */
		readonly limit = 0,
	) {}

	/** answer runs m as a command or a turn in the sender's conversation. A failure throws a ReplyError that still says what happened. */
	async answer(m: Message, signal: AbortSignal): Promise<Reply> {
		try { return await this.answering(m, signal); } finally { m.started?.(); }
	}

	private async answering(m: Message, signal: AbortSignal): Promise<Reply> {
		const id = m.conversationId || await this.conversationOf(m);
		let result;
		try { result = await this.conversation.commands.run({ client: this.client, conversationId: id, text: m.text }, m.owner, signal); } catch (err) {
			throw new ReplyError({ text: this.texts.failed(errorOf(err)).trim() }, err);
		}
		const requestId = m.id && m.id.length <= 100 ? m.id : newID();
		const input: ChatRequest = { id, text: m.text, requestId, owner: m.owner };
		let prefix = '';
		if (result.handled) {
			let reply = result.markdown ?? '';
			if (m.text === '/help' && this.texts.help) reply = this.texts.help + '\n\n' + reply;
			const a = result.action;
			if (!a) return { text: reply };
			if (a.kind === openConversation) {
				try { this.store.saveSetting(m.key, a.conversationId); } catch (err) { throw new ReplyError({ text: `Cannot save the ${this.name} conversation.` }, err); }
				return { text: reply };
			}
			if (a.kind !== decide) return { text: this.texts.unsupported };
			input.text = '';
			input.approval = { id: a.approvalId!, approved: !!a.approved, reason: a.reason, remember: a.remember };
			if (this.texts.decided) prefix = this.texts.decided(input.approval);
		}
		const [reply, err] = await this.turn(input, m.started, signal);
		if (input.approval && (isStaleApproval(err) || err instanceof NotFound)) return { text: this.texts.stale(input.approval.id), settled: input.approval.id };
		const refused = err instanceof CommandError ? err : undefined;
		if (input.approval && refused?.status !== 409 && !this.waits(id, input.approval.id)) reply.settled = input.approval.id;
		let failure: unknown = err;
		if (refused?.status === 409 && this.texts.busy && !reply.text.trim()) {
			// The previous turn is still running; this message was not taken.
			reply.text = this.texts.busy; failure = undefined;
		} else if (err && isAbort(err) && !signal.aborted && this.texts.stopped) {
			// Stopped by the sender rather than by Mob shutting down.
			reply.text += '\n\n' + this.texts.stopped; failure = undefined;
		} else if (refused?.status === 403) {
			// The sender may not do this, such as a guest remembering an approval; saying so is the answer.
			reply.text += this.texts.failed(refused); failure = undefined;
		} else if (err) reply.text += this.texts.failed(errorOf(err));
		else if (prefix) reply.text = prefix + '\n\n' + reply.text;
		reply.text = reply.text.trim() || this.texts.empty;
		if (failure) throw new ReplyError(reply, failure);
		return reply;
	}

	/** waits reports whether approval is still pending in the conversation. */
	private waits(conversation: string, approval: string) { return this.conversation.pending(conversation).some(p => p.id === approval); }

	/** conversationOf is the conversation m's sender writes to, created for a first message. */
	private conversationOf(m: Message): Promise<string> {
		const next = this.queue.then(() => {
			let id: string | undefined;
			try { id = this.store.setting<string>(m.key); } catch (err) { throw new ReplyError({ text: `Cannot load the ${this.name} conversation.` }, err); }
			if (!id && m.text !== '/new' && m.text !== '/help' && m.text !== '/stop') {
				try { id = this.store.create().id; } catch (err) { throw new ReplyError({ text: 'Cannot create a conversation.' }, err); }
				try { this.store.saveSetting(m.key, id); } catch (err) { throw new ReplyError({ text: `Cannot save the ${this.name} conversation.` }, err); }
			}
			return id ?? '';
		});
		this.queue = next.catch(() => {});
		return next;
	}

	/**
	 * turn runs one turn and collects what the sender sees of it: the text of
	 * its last step that wrote any, which concludes the turn, the tools it
	 * used, its failures and the approvals it asks for. Text written between
	 * tool calls, reasoning and tool calls stay in the local conversation.
	 */
	private async turn(input: ChatRequest, started: Message['started'], signal: AbortSignal): Promise<[Reply, unknown]> {
		input.channel = this.name;
		let step = '', last = '', failures = '';
		const used: Use[] = [];
		const approvals: PendingApproval[] = [];
		let err: unknown;
		try {
			await this.conversation.execute(input, e => {
				switch (e.kind) {
					case 'step-started': if (step.trim()) last = step; step = ''; break;
					case 'segment-delta': if (e.segment === 'text') step += e.text ?? ''; break;
					case 'tool-input': { const u = used.find(u => u.tool === e.toolName); if (u) u.times++; else used.push({ tool: e.toolName!, times: 1 }); break; }
					case 'approval-requested': approvals.push({ id: e.approvalId!, tool: e.toolName!, input: e.input }); break;
					case 'turn-failed': failures += '\nError: ' + e.error; break;
				}
				if (this.over(Math.max(bytes(step), bytes(last)) + bytes(failures), approvals)) throw this.overLimit();
			}, { signal, admitted: (r: Running) => started?.(() => r.stop()) });
		} catch (e) { err = e; }
		let text = (step.trim() ? step : last).trim();
		if (used.length && this.texts.used) text += this.texts.used(used);
		text += failures;
		if (approvals.length) text += this.texts.approvals(approvals, this.conversation.pending(input.id).length);
		if (!err && this.limit > 0 && bytes(text) > this.limit) err = this.overLimit();
		return [{ text, approvals }, err];
	}

	/**
	 * over reports whether a reply of n bytes followed by the prompt for
	 * approvals passes the limit. The prompt is measured as if one or several
	 * requests were pending, since the count is known only after the turn.
	 */
	private over(n: number, approvals: PendingApproval[]) {
		if (this.limit <= 0) return false;
		if (approvals.length) n += Math.max(bytes(this.texts.approvals(approvals, 1)), bytes(this.texts.approvals(approvals, 2)));
		return n > this.limit;
	}

	private overLimit() { return new Error(`reply exceeds the ${this.name} bridge limit`); }

	/**
	 * deliver answers the message with id and sends the answer once. Each step
	 * is recorded under id: a message already answered, or whose reply may
	 * have been sent, is never answered or sent again, and an interrupted send
	 * is reported rather than retried. A failed answer is still sent and then
	 * thrown.
	 */
	async deliver(id: string, answer: (signal: AbortSignal) => Promise<Reply>, send: (r: Reply, signal: AbortSignal) => Promise<void>, signal: AbortSignal) {
		if (this.accept(id)) await this.finish(id, answer, send, signal);
	}

	/**
	 * accept records the message with id as taken, so that a restart never
	 * answers it again, and reports whether it is new and must be finished
	 * with finish. A message whose send a restart interrupted is reported.
	 */
	accept(id: string): boolean {
		let delivery;
		try { delivery = this.store.delivery(id); } catch { throw new Error(`Cannot read ${this.name} delivery state`); }
		if (delivery?.state === 'sending') {
			this.store.updateDelivery(id, 'failed-or-unknown', delivery.reply, new Error('service interrupted during send'));
			throw new Error(`${this.name} reply delivery is uncertain; see local conversation history`);
		}
		if (delivery) return false;
		try { return this.store.acceptDelivery(id, 'processing'); } catch { throw new Error(`Cannot save ${this.name} message`); }
	}

	/** finish answers the message with id, which accept took, and sends the answer once, as deliver does. */
	async finish(id: string, answer: (signal: AbortSignal) => Promise<Reply>, send: (r: Reply, signal: AbortSignal) => Promise<void>, signal: AbortSignal) {
		let reply: Reply, answerErr: unknown;
		try { reply = await answer(signal); } catch (err) {
			answerErr = err;
			reply = err instanceof ReplyError ? err.reply : { text: '' };
		}
		if (signal.aborted) {
			const reason = errorOf(signal.reason);
			this.store.updateDelivery(id, 'cancelled', reply.text, reason);
			throw reason;
		}
		try { this.store.updateDelivery(id, 'sending', reply.text); } catch { throw new Error(`Cannot save ${this.name} reply`); }
		let sendErr: unknown;
		try { await send(reply, signal); } catch (err) { sendErr = err; }
		const state = sendErr ? 'failed-or-unknown' : answerErr ? 'processing-failed' : 'sent';
		const failure = [sendErr, answerErr].filter(Boolean).map(e => errorOf(e).message).join('\n');
		try { this.store.updateDelivery(id, state, reply.text, failure ? new Error(failure) : undefined); } catch { throw new Error(`Cannot save ${this.name} delivery status`); }
		// No automatic retry after an ambiguous send; the saved reply and chat history remain available locally.
		if (sendErr) throw new Error(`${this.name} reply delivery failed or is uncertain; see local conversation history`);
		if (answerErr) throw answerErr;
	}
}
