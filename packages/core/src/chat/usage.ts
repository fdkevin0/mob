// Usage as people read it.
import { formatDuration, formatMoney, formatTokens } from '../format';
import { cell } from './commands';
import type { Usage, UsageSummary } from './store';

/** brief is a summary in one line: tokens, cache reads and cost. */
export function brief(s: Usage) {
	let line = formatTokens(s.totalTokens) + ' tokens';
	if (s.cacheReadTokens > 0 && s.inputTokens > 0) line += ` (${Math.floor(s.cacheReadTokens * 100 / s.inputTokens)}% cached)`;
	if (s.cost > 0) line += ` · ${formatMoney(s.cost)}`;
	return line;
}

/** usageMarkdown shows a summary as a table, with a row for each model. */
export function usageMarkdown(s: UsageSummary) {
	let b = '| Model | Input | Cache read | Cache write | Output | Reasoning | Requests | Cost |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
	const row = (name: string, u: Usage) => {
		const cost = u.cost > 0 ? formatMoney(u.cost) : '—';
		b += `| ${name} | ${formatTokens(u.inputTokens)} | ${formatTokens(u.cacheReadTokens)} | ${formatTokens(u.cacheWriteTokens)} | ${formatTokens(u.outputTokens)} | ${formatTokens(u.reasoningTokens)} | ${u.requests} | ${cost} |\n`;
	};
	for (const m of s.models) row('`' + cell(m.model) + '`', m);
	if (s.models.length > 1) row('**All**', s);
	b += `\n${brief(s)} over ${s.turns} replies`;
	if (s.durationMs > 0) b += '; models worked ' + formatDuration(s.durationMs);
	return b + '. Input counts cached tokens; output counts reasoning.';
}
