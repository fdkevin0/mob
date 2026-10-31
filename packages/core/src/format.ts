// Numbers as people read them, the same in the web app, the terminal and the
// messaging apps: token counts, prices, durations and how fast a model wrote.
import type { Stats } from './chat/store';
import { efforts } from './llm/llm';

/** trim drops a fraction's trailing zeros: 1.20 is 1.2, 1.00 is 1. */
const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** formatTokens writes a token count short: 950, 1.2k, 46k, 1.24M. */
export function formatTokens(n: number) {
	if (n >= 1e6) return `${trim(n / 1e6, 2)}M`;
	if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
	if (n >= 1e3) return `${trim(n / 1e3, 1)}k`;
	return String(n);
}

/** formatMoney writes US dollars: cents above a dime, a tenth of a cent below it. */
export const formatMoney = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

/** formatDuration writes a span to the second: 45s, 3m 12s, 1h 5m. */
export function formatDuration(ms: number) {
	if (!Number.isFinite(ms) || ms < 0) return '';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** formatSeconds writes a short span finely: 420 ms is 0.4s, 12 300 is 12s, 65 000 is 1m 05s. */
export function formatSeconds(ms: number) {
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	const whole = Math.round(s);
	return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

/** replySpeed is how many output tokens a second a reply's model wrote once it had started, when that was measured. */
export function replySpeed(stats?: Partial<Stats>) {
	if (!stats?.generationMs || !stats.timedOutput) return undefined;
	return (stats.timedOutput * 1000) / stats.generationMs;
}

/** formatSpeed writes a reply speed: 4.5 tok/s, 52 tok/s. */
export const formatSpeed = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} tok/s`;

/** modelName is how a model reads: its ID without the provider or reasoning level. */
export function modelName(model: string) {
	const id = model.slice(model.indexOf('/') + 1);
	const colon = id.lastIndexOf(':');
	return colon > 0 && efforts.includes(id.slice(colon + 1)) ? id.slice(0, colon) : id;
}
