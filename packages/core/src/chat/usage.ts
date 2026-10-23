// Usage as people read it.
import { cell } from './commands';
import type { Usage, UsageSummary } from './store';

/** formatTokens writes n briefly, as 950, 12.3k or 1.24M. */
export function formatTokens(n: number) {
	if (n >= 1_000_000) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 10_000) return (n / 1e3).toFixed(0) + 'k';
	if (n >= 1000) return (n / 1e3).toFixed(1) + 'k';
	return String(n);
}

/** brief is a summary in one line: tokens, cache reads and cost. */
export function brief(s: Usage) {
	let line = formatTokens(s.totalTokens) + ' tokens';
	if (s.cacheReadTokens > 0 && s.inputTokens > 0) line += ` (${Math.floor(s.cacheReadTokens * 100 / s.inputTokens)}% cached)`;
	if (s.cost > 0) line += ` · $${s.cost.toFixed(2)}`;
	return line;
}

/** duration writes ms rounded to the second as Go writes durations, such as 1h2m3s. */
export function duration(ms: number) {
	let s = Math.round(ms / 1000);
	if (s === 0) return '0s';
	const h = Math.floor(s / 3600); s -= h * 3600;
	const m = Math.floor(s / 60); s -= m * 60;
	return (h ? h + 'h' : '') + (h || m ? m + 'm' : '') + s + 's';
}

/** usageMarkdown shows a summary as a table, with a row for each model. */
export function usageMarkdown(s: UsageSummary) {
	let b = '| Model | Input | Cache read | Cache write | Output | Reasoning | Requests | Cost |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
	const row = (name: string, u: Usage) => {
		const cost = u.cost > 0 ? '$' + u.cost.toFixed(4) : '—';
		b += `| ${name} | ${formatTokens(u.inputTokens)} | ${formatTokens(u.cacheReadTokens)} | ${formatTokens(u.cacheWriteTokens)} | ${formatTokens(u.outputTokens)} | ${formatTokens(u.reasoningTokens)} | ${u.requests} | ${cost} |\n`;
	};
	for (const m of s.models) row('`' + cell(m.model) + '`', m);
	if (s.models.length > 1) row('**All**', s);
	b += `\n${brief(s)} over ${s.turns} replies`;
	if (s.durationMs > 0) b += '; models worked ' + duration(s.durationMs);
	return b + '. Input counts cached tokens; output counts reasoning.';
}
