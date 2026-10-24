// An offline model: it echoes the prompt, turns "/remember fact" into a
// remember tool call, exercising approvals, and "/sandbox command" into a
// sandbox call when that tool is offered.
import { emptyResult, type Emit, type Info, type Model, type Ref, type Request, type Result } from './llm';

/** The reserved provider of the offline model. */
export const demoID = 'demo';
export const demoRef: Ref = { provider: demoID, model: 'echo', effort: '' };
export const demoInfo: Info = { id: 'echo', name: 'Demo (offline)', tools: true, known: true };

let calls = 0;
const callID = () => `demo_${Date.now()}${++calls}`;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) return reject(signal.reason);
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export class DemoModel implements Model {
	readonly ref = demoRef;
	readonly info = demoInfo;

	async stream(req: Request, emit: Emit, signal?: AbortSignal): Promise<Result> {
		const result = emptyResult();
		const last = req.messages[req.messages.length - 1];
		if (!last) return result;
		if (last.role === 'user' && last.text.startsWith('/remember ')) {
			result.calls = [{ id: callID(), name: 'remember', arguments: JSON.stringify({ fact: last.text.slice('/remember '.length) }) }];
			return result;
		}
		if (last.role === 'user' && last.text.startsWith('/sandbox ') && req.tools?.some(t => t.name === 'sandbox')) {
			result.calls = [{ id: callID(), name: 'sandbox', arguments: JSON.stringify({ command: last.text.slice('/sandbox '.length) }) }];
			return result;
		}
		if (last.role === 'tool') {
			result.text = 'Tool result: ' + last.text;
			await emit('text', result.text);
			return result;
		}
		const text = '[Demo mode — no model request]\n\nReceived: ' + last.text + '\n\nUse /remember a fact to exercise persistent approval.';
		for (const r of text) {
			await sleep(4, signal);
			result.text += r;
			await emit('text', r);
		}
		return result;
	}
}
