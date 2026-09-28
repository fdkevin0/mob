import { describe, it, expect } from 'vitest';
import { RateAwareQueue } from '../features/agent/outbound-queue';
import { TelegramError } from '../core/bot';

/** A fake clock for deterministic tests: controllable `now` and sync `sleep`. */
class FakeClock {
	nowMs = 0;
	sleepCalls: number[] = [];

	now = (): number => this.nowMs;
	sleep = async (ms: number): Promise<void> => {
		this.sleepCalls.push(ms);
		this.nowMs += ms;
	};

	advance(ms: number): void {
		this.nowMs += ms;
	}
}

/**
 * Drives the **Rate-aware queue** (docs/adr — Outbound queue): serial order,
 * the min-gap gate, 429 retry-once per `retry_after`, no-retry on non-429, and
 * chain continuity after a recovered error. Pure module + fake clock — no
 * Telegram.
 */
describe('RateAwareQueue', () => {
	it('runs enqueued items in serial order and returns their results in order', async () => {
		const clock = new FakeClock();
		const queue = new RateAwareQueue({ sleep: clock.sleep, now: clock.now });
		const order: number[] = [];

		const results = await Promise.all([
			queue.enqueue(async () => {
				order.push(1);
				return 'a';
			}),
			queue.enqueue(async () => {
				order.push(2);
				return 'b';
			}),
			queue.enqueue(async () => {
				order.push(3);
				return 'c';
			}),
		]);

		expect(order).toEqual([1, 2, 3]);
		expect(results).toEqual(['a', 'b', 'c']);
	});

	it('enforces the min-gap with a single sleep before the next send', async () => {
		const clock = new FakeClock();
		const queue = new RateAwareQueue({ minGapMs: 100, sleep: clock.sleep, now: clock.now });

		// First call: lastSendMs starts at -Infinity, so no min-gap enforced.
		await queue.enqueue(async () => 'first');
		expect(clock.nowMs).toBe(0);

		// Second call immediately after: elapsed=0 < 100, so should sleep 100ms.
		const sleepCountBefore = clock.sleepCalls.length;
		await queue.enqueue(async () => {
			clock.advance(1); // simulate 1ms execution
			return 'second';
		});

		// After the second call: slept 100ms + ran 1ms = nowMs should be 101.
		expect(clock.nowMs).toBe(101);
		expect(clock.sleepCalls.length).toBe(sleepCountBefore + 1);
		expect(clock.sleepCalls[sleepCountBefore]).toBe(100);
	});

	it('does not sleep when enough time has already passed', async () => {
		const clock = new FakeClock();
		const queue = new RateAwareQueue({ minGapMs: 100, sleep: clock.sleep, now: clock.now });

		// First call — no min-gap wait (initial lastSendMs is -Infinity).
		await queue.enqueue(async () => 'first');
		expect(clock.nowMs).toBe(0);

		// Advance well past the min-gap before enqueuing the second item.
		clock.advance(500);

		const sleepCountBefore = clock.sleepCalls.length;
		await queue.enqueue(async () => {
			clock.advance(1);
			return 'second';
		});

		// No new sleep call because elapsed (500ms) > min-gap (100ms).
		expect(clock.sleepCalls.length).toBe(sleepCountBefore);
	});

	it('retries once on a 429 with `retry_after`, then succeeds', async () => {
		const clock = new FakeClock();
		const queue = new RateAwareQueue({ sleep: clock.sleep, now: clock.now });

		let calls = 0;
		const result = await queue.enqueue(async () => {
			calls++;
			if (calls === 1) {
				throw new TelegramError(429, 'Too Many Requests', 2); // retry_after = 2s
			}
			return 'ok';
		});

		expect(calls).toBe(2);
		expect(result).toBe('ok');
		expect(clock.sleepCalls.length).toBe(1);
		expect(clock.sleepCalls[0]).toBe(2000);
	});

	it('caps a long retry_after at maxBackoffMs', async () => {
		const clock = new FakeClock();
		const queue = new RateAwareQueue({ maxBackoffMs: 5000, sleep: clock.sleep, now: clock.now });

		let calls = 0;
		const result = await queue.enqueue(async () => {
			calls++;
			if (calls === 1) {
				throw new TelegramError(429, 'Too Many Requests', 60); // 60s > 5s cap
			}
			return 'ok';
		});

		expect(calls).toBe(2);
		expect(result).toBe('ok');
		expect(clock.sleepCalls.length).toBe(1);
		expect(clock.sleepCalls[0]).toBe(5000);
	});

	it('propagates a TelegramError after a failed retry (initial + retry both fail)', async () => {
		const queue = new RateAwareQueue({ sleep: async () => {}, now: () => 0 });

		let calls = 0;
		await expect(
			queue.enqueue(async () => {
				calls++;
				throw new TelegramError(429, 'Too Many Requests', 1);
			})
		).rejects.toBeInstanceOf(TelegramError);
		expect(calls).toBe(2);
	});

	it('propagates a non-429 TelegramError without retry', async () => {
		const queue = new RateAwareQueue({ sleep: async () => {}, now: () => 0 });

		let calls = 0;
		await expect(
			queue.enqueue(async () => {
				calls++;
				throw new TelegramError(400, 'Bad Request');
			})
		).rejects.toBeInstanceOf(TelegramError);
		expect(calls).toBe(1);
	});

	it('propagates a plain Error (not a TelegramError)', async () => {
		const queue = new RateAwareQueue({ sleep: async () => {}, now: () => 0 });

		await expect(
			queue.enqueue(async () => {
				throw new Error('network unreachable');
			})
		).rejects.toThrow('network unreachable');
	});

	it('continues the chain after a recovered error', async () => {
		const queue = new RateAwareQueue({ sleep: async () => {}, now: () => 0 });

		// First item throws (will be caught by the caller's .catch).
		const first = queue.enqueue(async () => {
			throw new Error('fail');
		}).catch(() => 'recovered');

		// Second item should still run.
		const second = queue.enqueue(async () => 'success');

		const results = await Promise.all([first, second]);
		expect(results).toEqual(['recovered', 'success']);
	});

	it("uses the last successful send for the min-gap (a failed send's pre-wait counts)", async () => {
		const clock = new FakeClock();
		const queue = new RateAwareQueue({ minGapMs: 100, sleep: clock.sleep, now: clock.now });

		// First: successful — no min-gap wait (initial lastSendMs is -Infinity).
		await queue.enqueue(async () => 'ok');
		expect(clock.nowMs).toBe(0);

		// Second: fails. The min-gap sleep (100ms) runs before the fn, so nowMs
		// advances to 100 even though the send fails and lastSendMs stays at 0.
		await queue
			.enqueue(async () => {
				throw new Error('fail');
			})
			.catch(() => {});

		// After the failed send: nowMs=100 (min-gap sleep ran), lastSendMs=0 (unchanged).
		// The third call sees elapsed = 100 - 0 = 100 >= minGapMs → no extra sleep.
		const sleepCountBefore = clock.sleepCalls.length;
		await queue.enqueue(async () => {
			clock.advance(1);
			return 'third';
		});

		// No extra sleep because the min-gap was already satisfied by the second
		// call's pre-execution wait (lastSendMs stayed at 0, but nowMs advanced).
		expect(clock.sleepCalls.length).toBe(sleepCountBefore);
	});
});