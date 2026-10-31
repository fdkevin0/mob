// What agents used is recorded when each prompt ends, from what the prompt's
// response says it used (each runtime reads its own), or, for agents whose
// responses do not say, from what the agent's own records say its session
// used so far.
import type { llm } from '@mob/core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * normal counts input as every prompt token, as llm.Usage does. Agents that
 * count input without the cache, as Anthropic does, give a total that adds
 * the cache to it.
 */
export function normal(input: number, cacheRead: number, cacheWrite: number, output: number, reasoning: number, total: number): llm.Usage {
	if (cacheRead + cacheWrite > 0 && total >= input + cacheRead + cacheWrite + output) input += cacheRead + cacheWrite;
	return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

/**
 * codexTally reads what Codex recorded its session, a thread of the same ID,
 * used so far, and the model it last used, from the thread's rollout file.
 */
export async function codexTally(session: string): Promise<{ model: string; usage: llm.Usage }> {
	const home = process.env.CODEX_HOME || join(homedir(), '.codex');
	const usage: llm.Usage = { inputTokens: 0, outputTokens: 0 };
	const found = existsSync(join(home, 'sessions')) ? [...new Bun.Glob(`sessions/*/*/*/rollout-*-${session}.jsonl`).scanSync({ cwd: home, onlyFiles: true })].sort() : [];
	if (!found.length) return { model: '', usage };
	let model = '';
	let last = usage;
	for (const line of (await Bun.file(join(home, found[found.length - 1]!)).text()).split('\n')) {
		let item: { type?: string; payload?: { type?: string; model?: string; info?: { total_token_usage?: Record<string, number> } } };
		try { item = JSON.parse(line); } catch { continue; }
		if (item.type === 'turn_context' && item.payload?.model) model = item.payload.model;
		else if (item.type === 'event_msg' && item.payload?.type === 'token_count' && item.payload.info) {
			const t = item.payload.info.total_token_usage ?? {};
			last = { inputTokens: t.input_tokens ?? 0, outputTokens: t.output_tokens ?? 0, reasoningTokens: t.reasoning_output_tokens ?? 0, cacheReadTokens: t.cached_input_tokens ?? 0, cacheWriteTokens: t.cache_write_input_tokens ?? 0 };
		}
	}
	return { model, usage: last };
}
