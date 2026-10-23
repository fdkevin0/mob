// Running is an admitted turn and the log of its events. Any number of clients
// replay it from a point and follow it live; a turn admitted by start outlives
// the request that started it, and only stop, close or its timeout end it early.
import type { Event } from './events';

/** StepLimit is a turn that reached its tool step limit; it can be continued. */
export class StepLimit extends Error {
	readonly stepLimit = true;
}

export class Aborted extends Error {
	constructor(message = 'the turn was stopped') { super(message); }
}

export const isAbort = (e: unknown) => e instanceof Aborted || (e instanceof Error && (e.name === 'AbortError')) || (e instanceof DOMException && e.name === 'AbortError');

export class Running {
	private events: Event[] = [];
	private waiters: (() => void)[] = [];
	private ended = false;
	error?: Error;
	readonly controller = new AbortController();
	private finished: Promise<void>;
	private resolveFinished!: () => void;

	constructor() { this.finished = new Promise(r => { this.resolveFinished = r; }); }

	get signal() { return this.controller.signal; }

	record(e: Event) {
		this.events.push(e);
		this.wake();
	}

	private wake() {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) w();
	}

	// finish ends the log. A turn that failed after it began ends with the
	// events a client needs to show why. One that reached its step limit did
	// not fail: it ends as finished, and the saved reply's status tells clients
	// they can continue it, unless saving that reply failed too.
	finish(err?: Error) {
		if (err instanceof StepLimit && this.events.length) this.events.push({ kind: 'turn-finished', reason: 'tool-calls' });
		else if (err && this.events.length) {
			this.events.push(isAbort(err) || this.signal.aborted ? { kind: 'turn-aborted' } : { kind: 'turn-failed', error: err.message }, { kind: 'turn-finished', reason: 'error' });
		}
		this.error = err;
		this.ended = true;
		this.wake();
		this.resolveFinished();
	}

	/** messageId is the ID of the reply the turn writes, once it has started. */
	get messageId() { return this.events.find(e => e.kind === 'turn-started')?.messageId ?? ''; }

	stop() { this.controller.abort(new Aborted()); }

	get done() { return this.ended; }
	/** whenDone resolves when the turn has ended and every event is logged. */
	whenDone() { return this.finished; }

	// follow calls fn with each event after the first `after`, numbered from 1,
	// and waits for more until the turn ends or signal aborts. Once every event
	// is delivered it returns the turn's error.
	async follow(after: number, fn: (seq: number, e: Event) => void | Promise<void>, signal?: AbortSignal): Promise<Error | undefined> {
		for (;;) {
			const events = this.events.slice(Math.min(after, this.events.length));
			const ended = this.ended;
			for (let i = 0; i < events.length; i++) await fn(after + i + 1, events[i]);
			after += events.length;
			if (ended) return this.error;
			if (signal?.aborted) throw signal.reason;
			if (after < this.events.length) continue;
			await new Promise<void>(resolve => {
				const abort = () => resolve();
				signal?.addEventListener('abort', abort, { once: true });
				this.waiters.push(() => { signal?.removeEventListener('abort', abort); resolve(); });
			});
		}
	}

	/** begun waits for the turn's first event, or for it to end without one. */
	async begun(): Promise<boolean> {
		for (;;) {
			if (this.events.length) return true;
			if (this.ended) { if (this.error) throw this.error; return false; }
			await new Promise<void>(resolve => this.waiters.push(resolve));
		}
	}
}
