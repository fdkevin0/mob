/** Waits until the timer expires, or rejects with the signal's reason on cancellation. */
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) return reject(signal.reason);
	const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
	const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal!.reason); };
	signal?.addEventListener('abort', abort, { once: true });
});
