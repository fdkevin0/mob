// Summaries: folding older messages into a conversation's summary, so later turns read it in their place.
import { priced, refString, type Model, type Usage as LLMUsage } from '../llm/llm';
import { addLLMUsage, outcome } from './engine';
import { encode, ends, tokens } from './output';
import type { Message } from './store';

const compactPrompt = "You keep the summary of a conversation between a user and Mob, an assistant with tools, so that it can go on once older messages are dropped. Fold the new part of the conversation into the summary. Keep the user's goals, requests and preferences, decisions made, facts learned, names, files and paths, tool results that still matter, and unfinished work. Leave out pleasantries and whatever was superseded. Write plain text in the conversation's language.";
/** summaryTokens bounds a summary. */
export const summaryTokens = 4000;
/** summaryNotice introduces the summary in a turn's instructions. */
export const summaryNotice = '\n\nSummary of the earlier conversation, whose messages are no longer shown:\n';
/** transcriptOutput is how much of each tool output a summary reads. */
const transcriptOutput = 2000;

/** Requests are what each model request used, which model ran it and how long it took. */
export type Requests = { model: string; usage: LLMUsage; tookMs: number }[];

/** transcriptUsage is what the requests used together, or undefined without any. */
export function transcriptUsage(r: Requests): LLMUsage | undefined {
	let total: LLMUsage | undefined;
	for (const q of r) total = addLLMUsage(total, q.usage);
	return total;
}

/**
 * summarize folds messages into previous with model, as many messages at a
 * time as fit its window, in a summary of at most limit tokens, and returns
 * the new summary, what each of its requests used, and why it failed if it did.
 */
export async function summarize(signal: AbortSignal, model: Model, previous: string, messages: Message[], limit: number): Promise<[string, Requests, Error | undefined]> {
	const info = model.info;
	const context = info.context ?? 0;
	let maxTokens = Math.min(summaryTokens, limit);
	if (info.output && info.output > 0) maxTokens = Math.min(maxTokens, info.output);
	// About three words take four tokens.
	const system = compactPrompt + ` Use at most about ${Math.floor(maxTokens * 3 / 8)} words.`;
	const usage: Requests = [];
	let summary = previous, part = '';
	const flush = async () => {
		if (!part) return;
		let text = 'Conversation:\n' + part + '\nWrite the summary.';
		if (summary) text = 'Summary so far:\n' + summary + '\n\n' + text;
		if (context > 0 && tokens(system) + tokens(text) + maxTokens > context) throw new Error(`summarizing would exceed ${info.id}'s context`);
		const began = Date.now();
		let result;
		try {
			result = await model.stream({ system, messages: [{ role: 'user', text }], maxTokens }, () => {}, signal);
		} catch (e) {
			const partial = (e as { result?: { usage?: LLMUsage } }).result;
			if (partial?.usage) usage.push({ model: refString(model.ref), usage: priced(partial.usage, info.cost), tookMs: Date.now() - began });
			throw e;
		}
		if (result.usage) usage.push({ model: refString(model.ref), usage: priced(result.usage, info.cost), tookMs: Date.now() - began });
		if (!result.text.trim()) throw new Error('model wrote an empty summary');
		summary = result.text.trim();
		part = '';
	};
	// room is what the conversation part may take beside the instructions,
	// the summary so far and the summary to write.
	const room = () => (context <= 0 ? 100000 : context - maxTokens - tokens(system) - tokens(summary) - 100);
	try {
		for (const m of messages) {
			const text = transcript(m);
			for (;;) {
				// The room shrinks as the summary grows, so each message is fitted
				// against the summary it will be read with.
				const r = room();
				if (r <= 0) throw new Error(`${info.id}'s context is too small to summarize this conversation`);
				let fitted = text;
				if (tokens(fitted) > Math.floor(r / 2)) {
					const [head, tail] = ends(fitted, r, Math.floor(r / 2));
					fitted = head + '\n[...]\n' + tail;
				}
				if (!part || tokens(part) + tokens(fitted) <= r) { part += fitted; break; }
				await flush();
			}
		}
		await flush();
	} catch (e) {
		return ['', usage, e instanceof Error ? e : new Error(String(e))];
	}
	return [summary, usage, undefined];
}

/** transcript is a stored message as a summary reads it: who said what, and what tools were called with and returned, their outputs cut short. */
export function transcript(m: Message): string {
	if (m.command) return '';
	const who = m.role === 'assistant' ? 'Mob' : 'User';
	let b = '';
	for (const part of m.parts) {
		const kind = String(part.type);
		if (kind === 'text') {
			const text = String(part.text ?? '').trim();
			if (text) b += who + ': ' + text + '\n';
		} else if (kind.startsWith('tool-')) {
			let [head, tail] = ends(outcome(part), Math.floor(transcriptOutput * 2 / 3), Math.floor(transcriptOutput / 3));
			if (tail) head += ' [...] ' + tail;
			b += `Mob called ${kind.slice(5)} with ${encode(part.input)}; it returned ${head}\n`;
		}
	}
	return b;
}
