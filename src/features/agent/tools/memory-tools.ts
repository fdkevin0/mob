import { tool } from 'ai';
import { z } from 'zod';
import type { Memory } from '../../memory/memory';

/**
 * The **Memory tool** pair (PRD #72, docs/adr/0015) — thin AI-SDK wrappers over the
 * **Memory** module so a store/retrieve shows up as a tool call in the Debug trace.
 */
export function rememberTool(memory: Memory) {
	return tool({
		description:
			'Save a durable fact about the user or this conversation to long-term memory, ' +
			'so it can be recalled in future sessions. Use for stable preferences, names, dates, and decisions — not chit-chat.',
		inputSchema: z.object({
			fact: z.string().min(1).describe('A single concise fact to remember'),
		}),
		execute: async ({ fact }) => {
			await memory.remember(fact);
			return { saved: true };
		},
	});
}

export function recallTool(memory: Memory) {
	return tool({
		description: 'Search long-term memory for facts relevant to a query before answering, when prior context might help.',
		inputSchema: z.object({
			query: z.string().min(1).describe('What to look for in memory'),
		}),
		execute: async ({ query }) => {
			const hits = await memory.recall(query);
			return { memories: hits.map((hit) => hit.text) };
		},
	});
}
