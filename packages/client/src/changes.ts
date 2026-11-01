import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { MobClient } from './api';

/** Change says what a write on the service changed: a conversation, the conversation list, or the task tree. */
export type Change = { seq: number; conversation?: string; list?: boolean; tasks?: boolean };
/** reset means the stream (re)connected: changes may have been missed, so listeners reload what they show. */
export type ChangeListener = (change: Change | 'reset') => void;

const firstRetry = 1000;
const maxRetry = 30_000;

// Changes follows the service's change stream, GET /api/events. While it is live, clients reload only
// what changed and need not poll; a service without the stream leaves live false, and they keep polling.
export class Changes {
	live = false;
	private readonly listeners = new Set<ChangeListener>();
	private controller?: AbortController;
	private retry = firstRetry;
	private timer?: ReturnType<typeof setTimeout>;

	constructor(private readonly client: MobClient) {}

	subscribe = (listener: ChangeListener) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start = () => {
		this.stop();
		const controller = new AbortController();
		this.controller = controller;
		void this.follow(controller.signal);
		return this.stop;
	};

	stop = () => {
		this.controller?.abort();
		this.controller = undefined;
		clearTimeout(this.timer);
		this.live = false;
	};

	private emit(change: Change | 'reset') {
		this.listeners.forEach((listener) => listener(change));
	}

	private async follow(signal: AbortSignal) {
		let unsupported = false;
		try {
			const { url, token } = this.client.connection;
			const response = await this.client.fetch(`${url}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal });
			// A service from before the stream answers 404; its clients poll instead.
			if (response.status === 404) unsupported = true;
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			const live = () => {
				if (this.live) return;
				// The first event or comment confirms the subscription; anything before it may have been missed.
				this.live = true;
				this.retry = firstRetry;
				this.emit('reset');
			};
			const events = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: live })).getReader();
			for (;;) {
				const { value, done } = await events.read();
				if (done) break;
				live();
				try {
					this.emit(JSON.parse(value.data) as Change);
				} catch {
					/* an unreadable change is skipped; the next reset catches up */
				}
			}
		} catch {
			/* reconnects below */
		}
		if (signal.aborted) return;
		const wasLive = this.live;
		this.live = false;
		// Polling takes over at once while the stream is down.
		if (wasLive) this.emit('reset');
		const wait = unsupported ? 5 * 60_000 : this.retry;
		this.retry = Math.min(this.retry * 2, maxRetry);
		this.timer = setTimeout(() => {
			if (!signal.aborted) void this.follow(signal);
		}, wait);
	}
}
