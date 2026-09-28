import { tool } from 'ai';
import { z } from 'zod';
import type { RecentFeedEntries } from '../../feed/recent';

/**
 * The two read-only briefing tools (docs/adr/0028): `list_feed_updates` and
 * `list_recent_emails`. They exist so a **Scheduled turn** briefing prompt can
 * actually be composed — the poll crons collect, these read. Both are thin
 * shells over injected reader ports; the Conversation Agent binds the real
 * KV/D1 reads. `list_recent_emails` reads the admin's inbox, so it is
 * registered only for the admin's chat (the `schedule_turn` gating).
 */

const DEFAULT_SINCE_HOURS = 24;
const DEFAULT_EMAIL_LIMIT = 10;

export interface FeedUpdatesDeps {
	/** Entries published since the instant, across the chat's subscriptions. */
	recent: (since: Date) => Promise<RecentFeedEntries>;
	/** Clock, injected for tests. Defaults to `new Date()`. */
	now?: () => Date;
}

export function listFeedUpdatesTool(deps: FeedUpdatesDeps) {
	const now = deps.now ?? (() => new Date());
	return tool({
		description:
			'List recent entries from this chat\'s subscribed RSS/Atom feeds (title, link, publish time). ' +
			'Use for "anything new on my feeds?" and scheduled briefings.',
		inputSchema: z.object({
			since_hours: z.number().int().min(1).max(168).optional().describe('Look-back window in hours (default 24, max 168)'),
		}),
		execute: async ({ since_hours }) => {
			const since = new Date(now().getTime() - (since_hours ?? DEFAULT_SINCE_HOURS) * 3_600_000);
			return deps.recent(since);
		},
	});
}

/** One inbound email, summarized for the model — never the full body (use the Email tool's asset path for that). */
export interface RecentEmailSummary {
	id: number;
	from: string;
	subject: string | null;
	date: string | null;
	snippet: string | null;
}

export interface RecentEmailsDeps {
	/** The most recent inbound emails, newest first. */
	recent: (limit: number) => Promise<RecentEmailSummary[]>;
}

export function listRecentEmailsTool(deps: RecentEmailsDeps) {
	return tool({
		description:
			'List the most recent inbound emails (sender, subject, date, snippet), newest first. ' +
			'Use for "any new email?" and scheduled briefings.',
		inputSchema: z.object({
			limit: z.number().int().min(1).max(50).optional().describe('How many to return (default 10, max 50)'),
		}),
		execute: async ({ limit }) => ({ emails: await deps.recent(limit ?? DEFAULT_EMAIL_LIMIT) }),
	});
}
