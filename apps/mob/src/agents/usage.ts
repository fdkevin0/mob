// What agents used is recorded when each prompt ends, from what the prompt's
// response says it used, or, for agents whose responses do not say, from what
// the agent's own records say its session used so far.
import type { SessionConfigOption, Usage as ACPUsage } from '@agentclientprotocol/sdk';
import type { llm } from '@mob/core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** modelOption is the model a session's options select, if they name one. */
export function modelOption(options?: SessionConfigOption[] | null): string {
	for (const o of options ?? []) {
		if (o.type !== 'select' || o.category !== 'model') continue;
		const value = String(o.currentValue);
		// DeepSeek Harness names a model by its route: ["provider","model"].
		try {
			const route = JSON.parse(value);
			if (Array.isArray(route) && route.length) return String(route[route.length - 1]);
		} catch { /* a plain name */ }
		return value;
	}
	return '';
}

export type ModelUsage = { model: string; usage: llm.Usage };

/**
 * normal counts input as every prompt token, as llm.Usage does. Agents that
 * count input without the cache, as Anthropic does, give a total that adds
 * the cache to it.
 */
export function normal(input: number, cacheRead: number, cacheWrite: number, output: number, reasoning: number, total: number): llm.Usage {
	if (cacheRead + cacheWrite > 0 && total >= input + cacheRead + cacheWrite + output) input += cacheRead + cacheWrite;
	return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

type Tokens = { inputTokens?: number; cachedInputTokens?: number; cachedWriteTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number };

/** reported is what a prompt's response says it used, by model when its metadata breaks it down as Claude Agent's does. */
export function reported(u?: ACPUsage | null, meta?: Record<string, unknown> | null): ModelUsage[] {
	if (!u) return [];
	const total = normal(u.inputTokens, u.cachedReadTokens ?? 0, u.cachedWriteTokens ?? 0, u.outputTokens, u.thoughtTokens ?? 0, u.totalTokens);
	if (!total.inputTokens && !total.outputTokens) return [];
	const models = (meta?.quota as { model_usage?: { model?: string; token_count?: Tokens }[] } | undefined)?.model_usage;
	if (Array.isArray(models) && models.length) {
		const rows = models.map(m => {
			const t = m.token_count ?? {};
			return { model: m.model ?? '', usage: normal(t.inputTokens ?? 0, t.cachedInputTokens ?? 0, t.cachedWriteTokens ?? 0, t.outputTokens ?? 0, t.reasoningOutputTokens ?? 0, t.totalTokens ?? 0) };
		});
		// The breakdown is used only when it accounts for the whole.
		const input = rows.reduce((n, r) => n + r.usage.inputTokens, 0), output = rows.reduce((n, r) => n + r.usage.outputTokens, 0);
		if (input === total.inputTokens && output === total.outputTokens) return rows;
	}
	return [{ model: '', usage: total }];
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
