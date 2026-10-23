// Clearing tool outputs a prompt has read, to make room in the context window.
import type { Message as LLMMessage } from '../llm/llm';
import { encode, tokens, utf8Length } from './output';

/** ToolOutput is a tool output in a prompt, by its index among the messages, and where it is saved, if it is. */
export type ToolOutput = { index: number; file: string };

/** Outputs are tool outputs cleared together, with the tokens they take: estimated, or measured from the provider's usage. */
export type Outputs = { list: ToolOutput[]; tokens: number; measured: boolean; cleared: boolean };

/** each groups every tool output in messages on its own, with its estimated tokens. */
export function each(messages: LLMMessage[], saved: string[]): Outputs[] {
	const groups: Outputs[] = [];
	messages.forEach((m, i) => {
		if (m.role === 'tool') groups.push({ list: [{ index: i, file: saved[i] ?? '' }], tokens: tokens(m.text), measured: false, cleared: false });
	});
	return groups;
}

/**
 * clearOutputs replaces groups of tool outputs before index end, oldest
 * first, with a short note of what was there, until about need tokens are
 * freed, and returns the tokens freed. When the prompt's size is measured,
 * only measured groups are cleared. Groups that would free little are left.
 */
export function clearOutputs(messages: LLMMessage[], groups: Outputs[], end: number, need: number, measured: boolean): number {
	let freed = 0;
	for (const g of groups) {
		if (freed >= need) break;
		if (g.cleared || (measured && !g.measured) || g.list[g.list.length - 1].index >= end) continue;
		const notes = g.list.map(o => cleared(messages[o.index], o.file));
		const cost = notes.reduce((n, note) => n + noteTokens(note), 0);
		if (g.tokens - cost <= cost) continue;
		g.list.forEach((o, i) => { messages[o.index].text = notes[i]; });
		g.cleared = true;
		freed += g.tokens - cost;
	}
	return freed;
}

/** noteTokens counts a note's tokens generously, so clearing never claims more room than it makes. */
const noteTokens = (note: string) => Math.floor(utf8Length(note) / 2) + 1;

function cleared(m: LLMMessage, file: string) {
	let note = `This earlier ${m.toolName} output, about ${tokens(m.text)} tokens, was cleared to fit the context window.`;
	note += file ? ' The whole output is saved at ' + file + '.' : ' Run the tool again if you need it.';
	return encode({ cleared: true, note });
}
