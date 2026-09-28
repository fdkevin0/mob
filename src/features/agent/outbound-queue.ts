/**
 * A rate-aware outbound queue for persistent Telegram sends (issue #82).
 *
 * Telegram enforces ~1 msg/sec per chat. The Transcript Reply (#83) can emit a
 * burst of persistent messages in one turn — tool-start sends, tool-result
 * edits, segment finalizations, the fallback notice — and a parallel tool step
 * is the worst case. Without rate enforcement a `429` means a dropped
 * transcript message (swallowed-and-logged, but invisible to the user).
 *
 * `RateAwareQueue` replaces the simple promise chain in
 * `TelegramReplySurface.enqueue()`: it serializes sends, enforces a minimum gap
 * between completions, and honours `retry_after` on 429 with a single bounded
 * retry. Streamed drafts stay fire-and-forget (their own 800ms throttle).
 *
 * The queue is **per-turn** — one instance per `TelegramReplySurface` — and
 * accepts injected `sleep`/`now` so it can be tested with a fake clock.
 */
import { TelegramError } from '../../core/bot';

/** @internal min-gap default: small preventive gap; 429 retry is the real backstop. */
const DEFAULT_MIN_GAP_MS = 50;
/** @internal cap on retry_after — 30 s is far beyond what Telegram returns. */
const DEFAULT_MAX_BACKOFF_MS = 30000;

/**
 * A per-turn outbound queue that serializes Telegram API calls for the
 * Transcript Reply surface. Only **persistent** sends (message sends, edits,
 * the fallback notice) run through the queue; streamed drafts are unchanged.
 *
 * Every `enqueue()` call is **awaited** by the caller so the Transcript
 * orchestrator can guarantee a tool message lands before its following
 * segment. The queue swallows nothing — errors still propagate — so the
 * existing `TelegramReplySurface.enqueue()` wrapper retains its own
 * swallow-and-log behaviour.
 */
export class RateAwareQueue {
	private chain: Promise<void> = Promise.resolve();
	/** Timestamp of the last successful send, or a sentinel far in the past so the
	 *  first send never waits for the min-gap. */
	private lastSendMs = Number.NEGATIVE_INFINITY;

	private readonly minGapMs: number;
	private readonly maxBackoffMs: number;
	private readonly _sleep: (ms: number) => Promise<void>;
	private readonly _now: () => number;

	constructor(opts?: { minGapMs?: number; maxBackoffMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }) {
		this.minGapMs = opts?.minGapMs ?? DEFAULT_MIN_GAP_MS;
		this.maxBackoffMs = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
		this._sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this._now = opts?.now ?? (() => Date.now());
	}

	/**
	 * Enqueue `fn` for ordered, rate-limited execution.
	 *
	 * - Waits for all previously-enqueued items to complete.
	 * - Enforces `minGapMs` since the last successful send.
	 * - On a `TelegramError` with `errorCode === 429`: waits for `retryAfter`
	 *   (capped to `maxBackoffMs`), then retries **once**. If the retry also
	 *   fails the error propagates.
	 * - All other errors propagate immediately (the caller's `.catch()` logs
	 *   and returns `undefined` — one dropped message never blocks later ones).
	 *
	 * @returns the result of `fn`, or rejects if the call (and its optional
	 *   single retry) both fail.
	 */
	async enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(() => this._execute(fn));
		// Advance the chain: a rejection here must NOT poison later items, so
		// we catch-and-swallow to keep the chain alive. The real result/rejection
		// is returned via `run`, which the caller awaits.
		this.chain = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/** Execute one send with min-gap enforcement and 429 retry. */
	private async _execute<T>(fn: () => Promise<T>): Promise<T> {
		// Enforce min-gap since the last send that completed successfully.
		const elapsed = this._now() - this.lastSendMs;
		if (elapsed < this.minGapMs) {
			await this._sleep(this.minGapMs - elapsed);
		}

		try {
			const result = await fn();
			this.lastSendMs = this._now();
			return result;
		} catch (error) {
			if (error instanceof TelegramError && error.errorCode === 429) {
				// Telegram's `retry_after` is in seconds; fall back to 5 s when absent.
				const retryAfterMs = (error.retryAfter ?? 5) * 1000;
				const delay = Math.min(retryAfterMs, this.maxBackoffMs);
				console.warn({ message: 'Telegram 429, backing off', retryAfterMs: delay });
				await this._sleep(delay);
				// Retry once.
				const result = await fn();
				this.lastSendMs = this._now();
				return result;
			}
			// Non-429 or non-TelegramError — propagate to caller.
			throw error;
		}
	}
}
