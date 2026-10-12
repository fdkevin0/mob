import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, readUIMessageStream } from 'ai';
import { MobClient, type ChatMessage, type ClientType, type Snapshot } from './api';
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
	private active = false;
	private timer?: ReturnType<typeof setInterval>;
	private unsubscribes: (() => void)[] = [];
	private approvalController?: AbortController;
	private followController?: AbortController;
	private submittedText = '';

	constructor(
		private readonly options: {
			client: MobClient;
			id: string;
			initial: Snapshot;
			clientType: ClientType;
			onAction?: (action: Action) => void;
			onChanged?: () => void;
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
			fetch: client.fetch,
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
				if (this.active && !this.state.input) this.update({ input: this.submittedText });
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
	setInput = (input: string) => this.update({ input });
	dismissCommand = () => this.update({ commandResult: undefined });

	// Detaching cancels this client's streams, never the service-owned turn.
	// start/cleanup can repeat (including React StrictMode's effect replay).
	start = () => {
		this.active = true;
		this.unsubscribes = [
			this.chat['~registerMessagesCallback'](this.publishChat),
			this.chat['~registerStatusCallback'](this.publishChat),
			this.chat['~registerErrorCallback'](this.publishChat),
		];
		this.publishChat();
		void this.reload();
		this.options.onChanged?.();
		this.timer = setInterval(() => {
			void this.reload();
		}, pollInterval);
		return () => {
			this.active = false;
			this.generation++;
			clearInterval(this.timer);
			this.unsubscribes.forEach((unsubscribe) => unsubscribe());
			this.approvalController?.abort();
			this.followController?.abort();
			void this.chat.stop();
		};
	};

	private update(patch: Partial<ConversationState>) {
		const streaming = this.chat.status === 'submitted' || this.chat.status === 'streaming';
		this.state = { ...this.state, ...patch, streaming };
		this.state.busy = streaming || this.state.approvalBusy || this.state.remoteBusy || this.running || this.following;
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
		if (!this.active || this.state.streaming || this.state.approvalBusy || this.following || this.running) return;
		const generation = this.generation;
		try {
			const snapshot = await this.options.client.openConversation(this.options.id);
			if (
				!this.active ||
				generation !== this.generation ||
				this.state.streaming ||
				this.state.approvalBusy ||
				this.following ||
				this.running
			)
				return;
			this.chat.messages = snapshot.messages;
			this.update({
				model: snapshot.model,
				remoteBusy: snapshot.active,
				failure: this.state.failure === this.recoveryFailure ? '' : this.state.failure,
			});
			this.recoveryFailure = '';
			if (snapshot.active) void this.follow(snapshot.messages);
		} catch (e) {
			if (this.active && generation === this.generation) {
				this.recoveryFailure = errorText(e);
				this.update({ failure: this.recoveryFailure });
			}
		}
	}

	// Replays start from fresh state: never append replayed deltas to a draft.
	private async follow(baseline: ChatMessage[]) {
		if (this.followController || !this.active || Date.now() < this.followRetry) return;
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
			this.update({ failure: '' });
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
		this.recoveryFailure = '';
		this.chat.clearError();
		this.update({ input: '', failure: '', commandResult: undefined });
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
		this.chat.clearError();
		await this.send('Continue');
	};

	private async send(text: string) {
		this.submittedText = text;
		await this.chat.sendMessage({ text });
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
