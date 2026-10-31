import { DurableObject } from 'cloudflare:workers';
import { validEnvelope as sharedValid, type Envelope } from '@mob/core/relay';
import { limitedText } from './runners';
import { deliveryID, type GitHubEvent } from '@mob/core/github';

// Only routing metadata is visible here. The endpoints authenticate it as AES-GCM AAD.
export type { Envelope };
/** validEnvelope is the shared frame check plus the session and request ID forms the runner and browser use. */
export function validEnvelope(value: unknown): value is Envelope {
	return sharedValid(value) && /^[a-f0-9]{64}$/.test(value.session) && /^[a-f0-9-]{36}$/.test(value.id);
}
type Pending = {
	socket: WebSocket;
	controller: ReadableStreamDefaultController<Uint8Array>;
	timer: ReturnType<typeof setTimeout>;
	cleanup: () => void;
	cancel: () => void;
};

export class RunnerRelay extends DurableObject {
	private pending = new Map<string, Pending>();

	session(): string | null {
		const socket = this.ctx.getWebSockets('runner').find((socket) => socket.readyState === WebSocket.OPEN);
		return socket?.deserializeAttachment()?.session ?? null;
	}

	/**
	 * github queues a GitHub event for the runner and sends it at once if it is
	 * connected. The runner acknowledges each by delivery; the rest are sent
	 * again when it next connects, for up to a week, at most 500 of them.
	 */
	async github(event: GitHubEvent) {
		if (await this.ctx.storage.get('revoked')) return;
		await this.ctx.storage.put('gh:' + event.delivery, event);
		const queued = await this.ctx.storage.list<GitHubEvent>({ prefix: 'gh:' });
		if (queued.size > 500) {
			const oldest = [...queued.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, queued.size - 500).map(([k]) => k);
			await this.ctx.storage.delete(oldest);
		}
		this.sendGitHub([event]);
	}

	private async flushGitHub() {
		const queued = await this.ctx.storage.list<GitHubEvent>({ prefix: 'gh:' });
		const week = Date.now() - 7 * 86_400_000;
		const stale = [...queued.entries()].filter(([, e]) => e.at < week).map(([k]) => k);
		if (stale.length) await this.ctx.storage.delete(stale);
		const fresh = [...queued.values()].filter(e => e.at >= week).sort((a, b) => a.at - b.at);
		for (let i = 0; i < fresh.length; i += 50) this.sendGitHub(fresh.slice(i, i + 50));
	}

	private sendGitHub(events: GitHubEvent[]) {
		const socket = this.ctx.getWebSockets('runner').find(s => s.readyState === WebSocket.OPEN && s.deserializeAttachment()?.session);
		if (!socket || !events.length) return;
		try {
			socket.send(JSON.stringify({ type: 'github', events }));
		} catch {
			// Sent again when the runner reconnects.
		}
	}

	async revoke() {
		await this.ctx.storage.put('revoked', true);
		await this.ctx.storage.delete([...(await this.ctx.storage.list({ prefix: 'gh:' })).keys()]);
		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1008, 'Revoked');
			this.disconnect(socket);
		}
	}

	async fetch(request: Request): Promise<Response> {
		if (await this.ctx.storage.get('revoked')) return new Response('Runner revoked', { status: 403 });
		if (new URL(request.url).pathname === '/connect') {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 400 });
			for (const old of this.ctx.getWebSockets()) {
				old.close(1000, 'Replaced');
				this.disconnect(old);
			}
			const pair = new WebSocketPair();
			this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
			this.ctx.acceptWebSocket(pair[1], ['runner']);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		const socket = this.ctx.getWebSockets('runner').find((socket) => socket.readyState === WebSocket.OPEN);
		if (!socket || !this.session()) return new Response('Runner offline', { status: 503 });
		const raw = await limitedText(request, 2 * 1024 * 1024);
		let envelope: unknown;
		try {
			envelope = JSON.parse(raw ?? '');
		} catch {
			return new Response('Invalid envelope', { status: 400 });
		}
		if (!validEnvelope(envelope) || envelope.seq !== 0 || !envelope.final || envelope.session !== this.session())
			return new Response('Invalid or stale envelope', { status: 409 });
		const id = envelope.id;
		if (this.pending.has(id) || this.pending.size >= 32) return new Response('Runner busy', { status: 429 });
		const finish = () => {
			const pending = this.pending.get(id);
			if (!pending) return;
			clearTimeout(pending.timer);
			request.signal.removeEventListener('abort', abort);
			this.pending.delete(id);
		};
		// The runner holds a slot until its local request ends, so tell it when nobody reads the answer.
		const cancelRunner = () => {
			if (!this.pending.has(id)) return;
			try {
				socket.send(JSON.stringify({ type: 'cancel', id }));
			} catch {
				// A closed socket has already cancelled the runner's requests.
			}
		};
		const abort = () => {
			cancelRunner();
			this.pending.get(id)?.controller.error(new Error('Relay interrupted'));
			finish();
		};
		const stream = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.pending.set(id, { socket, controller, timer: setTimeout(abort, 360_000), cleanup: finish, cancel: cancelRunner });
					request.signal.addEventListener('abort', abort, { once: true });
					if (request.signal.aborted) {
						abort();
						return;
					}
					try {
						socket.send(JSON.stringify(envelope));
					} catch {
						abort();
					}
				},
				cancel: () => {
					cancelRunner();
					finish();
				},
			},
			new ByteLengthQueuingStrategy({ highWaterMark: 2 * 1024 * 1024 }),
		);
		return new Response(stream, {
			headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
		});
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== 'string' || message.length > 3 * 1024 * 1024) {
			socket.close(1009, 'Frame too large');
			this.disconnect(socket);
			return;
		}
		let frame;
		try {
			frame = JSON.parse(message);
		} catch {
			socket.close(1008, 'Invalid frame');
			this.disconnect(socket);
			return;
		}
		if (
			frame.type === 'hello' &&
			typeof frame.session === 'string' &&
			/^[a-f0-9]{64}$/.test(frame.session) &&
			!socket.deserializeAttachment()
		) {
			socket.serializeAttachment({ session: frame.session });
			void this.flushGitHub();
			return;
		}
		if (frame.type === 'github-ack' && Array.isArray(frame.ids) && socket.deserializeAttachment()) {
			const keys = frame.ids.filter((id: unknown) => typeof id === 'string' && deliveryID.test(id)).slice(0, 128).map((id: string) => 'gh:' + id);
			if (keys.length) void this.ctx.storage.delete(keys);
			return;
		}
		if (!validEnvelope(frame)) {
			socket.close(1008, 'Invalid envelope');
			this.disconnect(socket);
			return;
		}
		const pending = this.pending.get(frame.id);
		if (!pending || pending.socket !== socket) return;
		if ((pending.controller.desiredSize ?? 0) <= 0) {
			pending.cancel();
			pending.controller.error(new Error('Reader too slow; response incomplete'));
			pending.cleanup();
			return;
		}
		clearTimeout(pending.timer);
		pending.timer = setTimeout(() => {
			pending.cancel();
			pending.controller.error(new Error('Runner timeout'));
			pending.cleanup();
		}, 360_000);
		pending.controller.enqueue(new TextEncoder().encode(JSON.stringify(frame) + '\n'));
		if (frame.final) {
			pending.controller.close();
			pending.cleanup();
		}
	}

	private disconnect(socket: WebSocket) {
		for (const pending of this.pending.values()) {
			if (pending.socket === socket) {
				pending.controller.error(new Error('Runner disconnected'));
				pending.cleanup();
			}
		}
	}
	webSocketClose(socket: WebSocket) {
		this.disconnect(socket);
	}
	webSocketError(socket: WebSocket) {
		this.disconnect(socket);
	}
}
