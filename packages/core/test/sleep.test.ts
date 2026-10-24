import { expect, spyOn, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { DemoModel } from '../src/llm/demo';
import { sleep } from '../src/sleep';

test('completed waits leave no abort listeners on a reused signal', async () => {
	const { signal } = new AbortController();
	for (let i = 0; i < 20; i++) {
		await sleep(1, signal);
		expect(getEventListeners(signal, 'abort')).toHaveLength(0);
	}
	await sleep(1);
});

test('cancellation clears the timer and listener and preserves the reason', async () => {
	const controller = new AbortController();
	const reason = new Error('stop');
	const clear = spyOn(globalThis, 'clearTimeout');
	try {
		const waiting = sleep(60_000, controller.signal);
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
		controller.abort(reason);
		await expect(waiting).rejects.toBe(reason);
		expect(clear).toHaveBeenCalledTimes(1);
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
	} finally { clear.mockRestore(); }
});

test('an already cancelled signal creates no timer or listener', async () => {
	const signal = AbortSignal.abort('already stopped');
	const timer = spyOn(globalThis, 'setTimeout');
	try {
		await expect(sleep(60_000, signal)).rejects.toBe(signal.reason);
		expect(timer).not.toHaveBeenCalled();
		expect(getEventListeners(signal, 'abort')).toHaveLength(0);
	} finally { timer.mockRestore(); }
});

test('demo streaming does not retain listeners between characters', async () => {
	const controller = new AbortController();
	const model = new DemoModel();
	const request = { system: '', messages: [{ role: 'user' as const, text: 'hi' }] };
	await model.stream(request, () => {
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
	}, controller.signal);
	controller.abort(new Error('demo stopped'));
	await expect(model.stream(request, () => {}, controller.signal)).rejects.toBe(controller.signal.reason);
});
