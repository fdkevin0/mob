import { describe, it, expect } from 'vitest';
import { buildQuotedText, prependQuote } from '../features/agent/quote';

/**
 * Table-tests the pure `buildQuotedText` precedence (PRD #72, docs/adr/0015):
 * `quote.text` → `reply_to_message.text` → `reply_to_message.caption` → null.
 * Prior art: `update-route.test.ts`, `mcp-parse.test.ts`. No bot, no network.
 */
describe('buildQuotedText', () => {
	it('the highlighted span of a partial quote wins', () => {
		const text = buildQuotedText({
			quote: { text: 'the highlighted span' },
			reply_to_message: { text: 'the whole replied message' },
		});
		expect(text).toBe('the highlighted span');
	});

	it('falls back to the replied message text', () => {
		const text = buildQuotedText({
			reply_to_message: { text: 'replied text', caption: 'a caption' },
		});
		expect(text).toBe('replied text');
	});

	it('falls back to the caption when text is absent', () => {
		const text = buildQuotedText({
			reply_to_message: { caption: 'photo caption' },
		});
		expect(text).toBe('photo caption');
	});

	it('the rich_message branch delegates to the Rich Message reader', () => {
		// Replying to the bot's own answer: the content arrives as an Inbound Rich
		// Message (Bot API 10.1), not `text`/`caption`. Precedence delegates the rich
		// branch to the Rich Message reader — deep rendering is covered in reader.test.ts.
		const text = buildQuotedText({
			reply_to_message: {
				rich_message: {
					blocks: [{ type: 'paragraph', text: 'from the bot' }],
				} as any,
			},
		});
		expect(text).toBe('from the bot');
	});

	it('returns null when there is no quotable content', () => {
		expect(buildQuotedText({})).toBeNull();
		expect(buildQuotedText({ reply_to_message: {} })).toBeNull();
	});

	it('skips empty strings and falls through', () => {
		const text = buildQuotedText({
			quote: { text: '' },
			reply_to_message: { text: 'real text' },
		});
		expect(text).toBe('real text');
	});
});

describe('prependQuote', () => {
	it('formats a blockquote followed by the question', () => {
		const composed = prependQuote('line one\nline two', 'my question');
		expect(composed).toBe('> line one\n> line two\n\nmy question');
	});
});