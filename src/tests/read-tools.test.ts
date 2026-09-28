import { describe, it, expect } from 'vitest';
import type { Env } from '../core/env';
import { listFeedUpdatesTool, listRecentEmailsTool } from '../features/agent/tools/read-tools';
import { recentFeedEntries } from '../features/feed/recent';
import { builtinToolSummaries } from '../features/agent/tools';

/** Invoke an AI-SDK tool's execute with a minimal options bag. */
async function run(tool: any, args: unknown): Promise<any> {
	return tool.execute(args, { toolCallId: 't', messages: [] });
}

const NOW = new Date('2026-07-02T10:00:00Z');

/**
 * Tests the two read-only briefing tools (docs/adr/0028): `list_feed_updates`
 * over the chat's subscriptions (fake KV + fake fetch, no network) and
 * `list_recent_emails` over an injected reader port.
 */

/** A minimal RSS body with two dated items. */
function rss(items: Array<{ title: string; link: string; pubDate: string }>): string {
	const itemXml = items
		.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pubDate}</pubDate></item>`)
		.join('');
	return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title>${itemXml}</channel></rss>`;
}

/** A fake `FEEDS` KV: `list` + `get` over fixed feed configs. */
function fakeFeedsKv(configs: Record<string, { url: string; title?: string; subscribers: number[] }>) {
	return {
		list: async () => ({ keys: Object.keys(configs).map((name) => ({ name })) }),
		get: async (key: string) => configs[key] ?? null,
	} as unknown as Env['FEEDS'];
}

describe('recentFeedEntries / list_feed_updates tool', () => {
	it('filters entries by the since cutoff and by chat subscription; only fetches the chat\'s feed', async () => {
		const kv = fakeFeedsKv({
			'feed-a': { url: 'https://a.example/rss', title: 'A', subscribers: [42] },
			'feed-b': { url: 'https://b.example/rss', title: 'B', subscribers: [999] }, // another chat's feed
		});
		const fakeFetch = (async (url: string) => {
			expect(url).toBe('https://a.example/rss');
			return new Response(
				rss([
					{ title: 'Fresh', link: 'https://a.example/1', pubDate: 'Thu, 02 Jul 2026 08:00:00 GMT' },
					{ title: 'Stale', link: 'https://a.example/2', pubDate: 'Mon, 01 Jun 2026 08:00:00 GMT' },
				])
			);
		}) as unknown as typeof fetch;

		const updates = await recentFeedEntries({
			feeds: kv,
			chatId: 42,
			since: new Date('2026-07-01T10:00:00Z'),
			fetch: fakeFetch,
		});
		expect(updates.entries.length).toBe(1);
		expect(updates.entries[0].title === 'Fresh' && updates.entries[0].feed === 'A').toBe(true);

		const t = listFeedUpdatesTool({ recent: (since) => recentFeedEntries({ feeds: kv, chatId: 42, since, fetch: fakeFetch }), now: () => NOW });
		const out = await run(t, { since_hours: 24 });
		expect(Array.isArray(out.entries) && out.entries.length === 1).toBe(true);
	});

	it('skips a failing feed but still returns entries from healthy feeds and reports failures by name', async () => {
		const kv = fakeFeedsKv({
			'feed-a': { url: 'https://a.example/rss', title: 'A', subscribers: [42] },
			'feed-c': { url: 'https://c.example/rss', title: 'C', subscribers: [42] },
		});
		const fakeFetch = (async (url: string) => {
			if (url.includes('c.example')) throw new Error('connection refused');
			return new Response(rss([{ title: 'Fresh', link: 'https://a.example/1', pubDate: 'Thu, 02 Jul 2026 08:00:00 GMT' }]));
		}) as unknown as typeof fetch;

		const updates = await recentFeedEntries({ feeds: kv, chatId: 42, since: new Date('2026-07-01T10:00:00Z'), fetch: fakeFetch });
		expect(updates.entries.length).toBe(1);
		expect(updates.failed.length === 1 && updates.failed[0] === 'C').toBe(true);
	});

	it('an empty result is a normal empty result', async () => {
		const t = listFeedUpdatesTool({ recent: async () => ({ entries: [], failed: [] }), now: () => NOW });
		const out = await run(t, {});
		expect(Array.isArray(out.entries) && out.entries.length === 0).toBe(true);
	});
});

describe('list_recent_emails tool', () => {
	it('lists emails, forwarding the limit; default limit is 10', async () => {
		const t = listRecentEmailsTool({
			recent: async (limit) => {
				expect(limit).toBe(5);
				return [
					{ id: 7, from: 'boss@example.com', subject: 'Q3 numbers', date: '2026-07-02T08:00:00Z', snippet: 'Please review…' },
				];
			},
		});
		const out = await run(t, { limit: 5 });
		expect(Array.isArray(out.emails) && out.emails.length === 1).toBe(true);
		expect(out.emails[0].subject).toBe('Q3 numbers');

		const defaulted = await run(
			listRecentEmailsTool({
				recent: async (limit) => {
					expect(limit).toBe(10);
					return [];
				},
			}),
			{}
		);
		expect(defaulted.emails.length).toBe(0);
	});
});

describe('builtinToolSummaries', () => {
	it('feed summary counts entries and notes failures', () => {
		expect(builtinToolSummaries.list_feed_updates({ entries: [1, 2, 3], failed: [] })).toBe('3 entries');
		expect(builtinToolSummaries.list_feed_updates({ entries: [1], failed: ['C'] })).toBe('1 entry · 1 feed failed');
	});

	it('email summary counts', () => {
		expect(builtinToolSummaries.list_recent_emails({ emails: [1, 2] })).toBe('2 emails');
	});
});