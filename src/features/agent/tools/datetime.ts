import { tool } from 'ai';
import { z } from 'zod';

export interface DatetimeDeps {
	/** Current instant. Defaults to `new Date()`; injected for tests. */
	now: () => Date;
	/** Zone used when the model passes no `timezone` (the bot's home zone). */
	defaultTimezone: string;
}

/**
 * **Datetime tool** (PRD #72, docs/adr/0015). Returns the current instant: the
 * UTC ISO string always, plus a readable string localized to the requested zone
 * (or the bot's default). An invalid IANA zone falls back to UTC rather than
 * failing the turn.
 */
export function datetimeTool(deps: DatetimeDeps) {
	return tool({
		description:
			'Get the current date and time. Optionally pass an IANA timezone (e.g. "Asia/Shanghai"); ' +
			'defaults to the bot\'s configured timezone. Always returns the UTC ISO instant too.',
		inputSchema: z.object({
			timezone: z.string().optional().describe('IANA timezone name, e.g. "Europe/London"'),
		}),
		execute: async ({ timezone }) => {
			const date = deps.now();
			const requested = timezone ?? deps.defaultTimezone;
			let resolved = requested;
			let readable: string;
			try {
				readable = format(date, requested);
			} catch {
				resolved = 'UTC';
				readable = format(date, 'UTC');
			}
			return { iso: date.toISOString(), readable, timezone: resolved };
		},
	});
}

function format(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone }).format(date);
}
