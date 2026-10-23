import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, generateId, readUIMessageStream } from 'ai';
import { MobClient, type ChatMessage, type ClientType, type Snapshot } from './api';
import type { Changes } from './changes';
import type { Action, CommandResult } from './contracts';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pollInterval = 2000;

export type ConversationState = {
	model: string;
	input: string;
	messages: ChatMessage[];
	streaming: boolean;
	busy: boolean;
	remoteBusy: boolean;
	approvalBusy: boolean;
	failure: string;
	error?: Error;
	commandResult?: string;
	recovery?: { requestId: string; text: string };
};

// Chat is the AI SDK's headless state container, not a React hook. Both UIs
// subscribe to this client; only their adapters own UI events and rendering.
export class ConversationClient {
	private readonly chat: Chat<ChatMessage>;
	private readonly transport: DefaultChatTransport<ChatMessage>;
	private readonly listeners = new Set<() => void>();
	private state: ConversationState;
	private running = false;
	private following = false;
	private followRetry = 0;
	private recoveryFailure = '';
	private generation = 0;
	private reloadSequence = 0;
	private publishedReloadSequence = 0;
	private active = false;
	private timer?: ReturnType<typeof setInterval>;
	private unsubscribes: (() => void)[] = [];
	private approvalController?: AbortController;
	private followController?: AbortController;
	private inputRevision = 0;
	// stale is set when history may have changed but could not be reloaded yet; the next tick reloads it.
	private stale = false;
	private pendingSend?: { requestId: string; text: string; inputRevision: number; settled: boolean; uncertain: boolean };

	constructor(
		private readonly options: {
			client: MobClient;
			id: string;
			initial: Snapshot;
			clientType: ClientType;
			onAction?: (action: Action) => void;
			onChanged?: () => void;
			/** throttleMs limits how often streamed text updates subscribers, so a UI renders at most once per interval. */
			throttleMs?: number;
			/** changes, while live, replaces polling: the conversation reloads when the service says it changed. */
			changes?: Changes;
		},
	) {
		const { client, id, initial } = options;
		this.state = {
			model: initial.model,
			input: '',
			messages: initial.messages,
			streaming: false,
			busy: initial.active,
			remoteBusy: initial.active,
			approvalBusy: false,
			failure: '',
		};
		this.transport = new DefaultChatTransport<ChatMessage>({
			api: `${client.connection.url}/api/chat`,
			headers: { Authorization: `Bearer ${client.connection.token}` },
			fetch: client.fetch as typeof fetch,
			prepareSendMessagesRequest: ({ messages, body }) => {
				if (body?.approval) return { body: { id, approval: body.approval } };
				const last = messages.at(-1);
				return {
					body: {
						id,
						requestId: last?.id,
						text: last?.parts
							.filter((p) => p.type === 'text')
							.map((p) => p.text)
							.join(''),
					},
				};
			},
		});
		this.chat = new Chat<ChatMessage>({
			id,
			messages: initial.messages,
			transport: this.transport,
			onError: () => {
				if (this.pendingSend) this.pendingSend.uncertain = true;
			},
		});
	}

	getSnapshot = (): ConversationState => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	setInput = (input: string) => {
		this.inputRevision++;
		this.update({ input });
	};
	dismissCommand = () => this.update({ commandResult: undefined });

	// Detaching cancels this client's streams, never the service-owned turn.
	// start/cleanup can repeat (including React StrictMode's effect replay).
	start = () => {
		this.active = true;
		this.unsubscribes = [
			this.chat['~registerMessagesCallback'](this.publishChat, this.options.throttleMs),
			this.chat['~registerStatusCallback'](this.publishChat),
			this.chat['~registerErrorCallback'](this.publishChat),
		];
		this.publishChat();
		void this.reload();
		this.options.onChanged?.();
		// A hidden page skips polling and catches up as soon as it is shown again.
		const hidden = () => typeof document !== 'undefined' && document.hidden;
		const shown = () => {
			if (!hidden()) void this.reload();
		};
		if (typeof document !== 'undefined') document.addEventListener('visibilitychange', shown);
		// While the change stream is live, ticks only retry a reload that had to wait.
		this.timer = setInterval(() => {
			if (!hidden() && (this.stale || !this.options.changes?.live)) void this.reload();
		}, pollInterval);
		const unsubscribe = this.options.changes?.subscribe((change) => {
			if (change === 'reset' || change.conversation === this.options.id) void this.reload();
		});
		return () => {
			unsubscribe?.();
			if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', shown);
			this.active = false;
			this.generation++;
			clearInterval(this.timer);
			this.unsubscribes.forEach((unsubscribe) => unsubscribe());
			this.approvalController?.abort();
			this.followController?.abort();
			if (this.pendingSend) this.pendingSend.uncertain = true;
			void this.chat.stop();
		};
	};

	private update(patch: Partial<ConversationState>) {
		const streaming = this.chat.status === 'submitted' || this.chat.status === 'streaming';
		this.state = { ...this.state, ...patch, streaming };
		this.state.busy =
			streaming ||
			this.state.approvalBusy ||
			this.state.remoteBusy ||
			this.running ||
			this.following ||
			(!!this.pendingSend && !this.state.recovery);
		this.listeners.forEach((listener) => listener());
	}

	private publishChat = () => {
		const wasStreaming = this.state.streaming;
		this.update({ messages: this.chat.messages, error: this.chat.error });
		if (wasStreaming && !this.state.streaming && this.active) {
			void this.reload();
			this.options.onChanged?.();
		}
	};

	private async reload() {
		if (
			!this.active ||
			this.state.streaming ||
			this.state.approvalBusy ||
			this.following ||
			this.running ||
			(this.pendingSend && !this.pendingSend.settled)
		) {
			this.stale = true;
			return;
		}
		this.stale = false;
		const generation = this.generation;
		const sequence = ++this.reloadSequence;
		try {
			const snapshot = await this.options.client.openConversation(this.options.id);
			if (
				!this.active ||
				generation !== this.generation ||
				sequence <= this.publishedReloadSequence ||
				this.state.streaming ||
				this.state.approvalBusy ||
				this.following ||
				this.running ||
				(this.pendingSend && !this.pendingSend.settled)
			) {
				this.stale = true;
				return;
			}
			this.publishedReloadSequence = sequence;
			const pending = this.pendingSend;
			if (pending) {
				if (snapshot.messages.some((m) => m.role === 'user' && m.id === pending.requestId)) {
					this.pendingSend = undefined;
					this.chat.clearError();
					this.update({
						input: this.inputRevision === pending.inputRevision && this.state.input === pending.text ? '' : this.state.input,
						failure: this.state.recovery ? '' : this.state.failure,
						recovery: undefined,
					});
				} else {
					this.update({
						recovery: { requestId: pending.requestId, text: pending.text },
						input: this.inputRevision === pending.inputRevision && !this.state.input ? pending.text : this.state.input,
						failure: 'Delivery not confirmed. Original message retained for recovery; it was not resent.',
					});
				}
			}
			const messages = reuseMessages(this.chat.messages, snapshot.messages);
			if (messages !== this.chat.messages) this.chat.messages = messages;
			this.update({
				model: snapshot.model,
				remoteBusy: snapshot.active,
				failure: this.state.failure === this.recoveryFailure ? '' : this.state.failure,
			});
			this.recoveryFailure = '';
			if (snapshot.active) void this.follow(snapshot.messages);
		} catch (e) {
			this.stale = true;
			if (
				this.active &&
				generation === this.generation &&
				sequence > this.publishedReloadSequence &&
				!this.state.streaming &&
				!this.state.approvalBusy &&
				!this.following &&
				!this.running &&
				(!this.pendingSend || this.pendingSend.settled)
			) {
				this.publishedReloadSequence = sequence;
				this.recoveryFailure = errorText(e);
				// Delivery stays unknown (and busy) until history can be read, but
				// the original returns to an untouched editor so it is not lost.
				const pending = this.pendingSend;
				if (pending) {
					this.recoveryFailure += ' · Delivery not confirmed yet. Original message kept in the editor; it was not resent.';
					this.update({
						failure: this.recoveryFailure,
						input: this.inputRevision === pending.inputRevision && !this.state.input ? pending.text : this.state.input,
					});
				} else this.update({ failure: this.recoveryFailure });
			}
		}
	}

	// Replays start from fresh state: never append replayed deltas to a draft.
	private async follow(baseline: ChatMessage[]) {
		if (this.followController || !this.active) return;
		// A follow that failed waits a tick before trying again.
		if (Date.now() < this.followRetry) {
			this.stale = true;
			return;
		}
		const controller = new AbortController();
		this.followController = controller;
		this.following = true;
		this.update({});
		let completed = false;
		try {
			const stream = await this.transport.reconnectToStream({ chatId: this.options.id, abortSignal: controller.signal });
			if (controller.signal.aborted) return;
			if (!stream) {
				completed = true;
				return;
			}
			if (!this.state.recovery) this.update({ failure: '' });
			const earlier = baseline.filter((m) => m.metadata?.status !== 'streaming');
			for await (const message of readUIMessageStream<ChatMessage>({ stream, terminateOnError: true })) {
				if (!controller.signal.aborted) this.chat.messages = [...earlier.filter((m) => m.id !== message.id), message];
			}
			completed = !controller.signal.aborted;
		} catch (e) {
			if (!controller.signal.aborted) {
				this.followRetry = Date.now() + pollInterval;
				this.recoveryFailure = errorText(e);
				this.update({ failure: this.recoveryFailure });
			}
		} finally {
			this.followController = undefined;
			this.following = false;
			this.stale = true;
			this.update(completed ? { remoteBusy: false } : {});
			// The next poll reconciles persisted history. Do not loop on a stale
			// active snapshot followed by 204, or replace the just-replayed reply.
			if (this.active) this.options.onChanged?.();
		}
	}

	submit = async (input = this.state.input) => {
		if (!this.active || !input.trim() || this.state.busy) return;
		const text = input.trim();
		this.generation++;
		this.pendingSend = undefined;
		this.recoveryFailure = '';
		this.chat.clearError();
		this.update({ input: '', failure: '', commandResult: undefined, recovery: undefined });
		if (!text.startsWith('/') || /[\r\n]/.test(text)) {
			await this.send(text);
			return;
		}
		this.running = true;
		this.update({});
		const generation = this.generation;
		try {
			const result = await this.options.client.request<CommandResult>('/commands/run', {
				client: this.options.clientType,
				conversationId: this.options.id,
				text,
			});
			if (!this.active || generation !== this.generation) return;
			this.running = false;
			this.update({ commandResult: result.markdown });
			if (!result.handled) await this.send(text);
			else if (result.action?.kind === 'decide')
				await this.decide(result.action.approvalId ?? '', result.action.approved ?? false, result.action.reason, result.action.remember);
			else if (result.action) this.options.onAction?.(result.action);
		} catch (e) {
			if (this.active && generation === this.generation) this.update({ failure: errorText(e), input: this.state.input || text });
		} finally {
			this.running = false;
			this.update({});
			if (this.active) {
				void this.reload();
				this.options.onChanged?.();
			}
		}
	};

	// Continue is an explicit new turn; retain any draft already in the editor.
	proceed = async () => {
		if (!this.active || this.state.busy) return;
		this.generation++;
		this.pendingSend = undefined;
		this.recoveryFailure = '';
		this.chat.clearError();
		this.update({ failure: '', recovery: undefined });
		await this.send('Continue');
	};

	private async send(text: string) {
		const pending = { requestId: generateId(), text, inputRevision: this.inputRevision, settled: false, uncertain: false };
		this.pendingSend = pending;
		try {
			await this.chat.sendMessage({ id: pending.requestId, role: 'user', parts: [{ type: 'text', text }] });
		} finally {
			pending.settled = true;
			if (!pending.uncertain) this.pendingSend = undefined;
			this.update({});
			if (this.active) await this.reload();
		}
	}

	decide = async (approvalId: string, approved: boolean, reason?: string, remember?: string) => {
		if (!this.active || this.state.busy) return;
		this.generation++;
		this.recoveryFailure = '';
		this.chat.clearError();
		this.update({ approvalBusy: true, failure: '' });
		const controller = new AbortController();
		this.approvalController = controller;
		try {
			const stream = await this.transport.sendMessages({
				chatId: this.options.id,
				messages: [],
				trigger: 'submit-message',
				messageId: undefined,
				abortSignal: controller.signal,
				body: { approval: { id: approvalId, approved, reason: reason?.trim() || undefined, remember: remember || undefined } },
			});
			const baseline = (await this.options.client.openConversation(this.options.id)).messages.filter(
				(m) => m.metadata?.status !== 'streaming',
			);
			for await (const message of readUIMessageStream<ChatMessage>({ stream, terminateOnError: true })) {
				if (!controller.signal.aborted && (approved || reason?.trim()))
					this.chat.messages = [...baseline.filter((m) => m.id !== message.id), message];
			}
		} catch (e) {
			if (!controller.signal.aborted) this.update({ failure: errorText(e) });
		} finally {
			this.approvalController = undefined;
			this.update({ approvalBusy: false });
			if (this.active) {
				void this.reload();
				this.options.onChanged?.();
			}
		}
	};

	cancel = async () => {
		try {
			await this.options.client.request(`/conversations/${this.options.id}/stop`, {});
			this.approvalController?.abort();
			this.followController?.abort();
			if (this.pendingSend) this.pendingSend.uncertain = true;
			await this.chat.stop();
			if (this.active) void this.reload();
		} catch (e) {
			if (this.active) {
				this.recoveryFailure = '';
				this.update({ failure: errorText(e) });
			}
		}
	};
}

// reuseMessages keeps each message object that a reload left unchanged, so a UI that memoizes
// messages by identity only renders what changed; it returns current itself when nothing did.
export function reuseMessages(current: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
	const byId = new Map(current.map((m) => [m.id, m]));
	let changed = current.length !== next.length;
	const merged = next.map((message, index) => {
		const previous = byId.get(message.id);
		const kept = previous && JSON.stringify(previous) === JSON.stringify(message) ? previous : message;
		if (kept !== current[index]) changed = true;
		return kept;
	});
	return changed ? merged : current;
}
