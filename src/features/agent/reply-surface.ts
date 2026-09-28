/** Telegram delivery adapter for surface-neutral turn events. */
import type { Bot } from '../../core/bot';
import { serializeDebugTrace, type DebugTrace } from './debug-trace';
import { toolLine, toolStartLine } from './transcript';
import { RateAwareQueue } from './outbound-queue';
import type { TurnEvent } from './turn-events';

/** One silent tool message, edited on completion in submission order. */
export interface ToolMessage {
	/** Show the result summary and elapsed time; the input label was captured at tool start. */
	done(detail: { summary: string; durationMs: number }): Promise<void>;
	/** Edit the message to its failure line (`⚠️ name · <label> · failed: <short error> · <duration>`). */
	fail(detail: { shortError: string; durationMs: number }): Promise<void>;
}

/** Id-free delivery seam used by the turn core. */
export interface ReplySurface {
	draft(markdown: string): void;
	endSegment(markdown: string, opts: { final: boolean }): Promise<void>;
	toolStart(name: string, label?: string): ToolMessage;
	notice(text: string): Promise<void>;
	document(trace: DebugTrace): Promise<void>;
}

/** Minimum gap between streamed draft updates, to respect Telegram rate limits. */
const DRAFT_THROTTLE_MS = 800;

/** Offset between successive segments' draft ids, so their animations don't collide. */
const SEGMENT_DRAFT_STRIDE = 1_000_000;

/** Rich Message cap. No splitting: reply-surface tests check the model output-budget assumption. */
export const RICH_MESSAGE_CHAR_LIMIT = 32768;

/** Native placeholder for an empty streaming draft; tool activity has separate messages. */
const THINKING_BLOCK = '<tg-thinking>Thinking…</tg-thinking>';

/**
 * Render accumulated reasoning as a Telegram blockquote: every line must start
 * with `>` for the quote to render correctly across a multi-line, growing string.
 */
function quoteBlock(text: string): string {
	return '> ' + text.replaceAll('\n', '\n> ');
}

/** Reasoning is draft-only; final segments contain the answer without the reasoning preview. */
function composeDraft(reasoning: string, answer: string): string {
	if (!reasoning) return answer;
	const quoted = quoteBlock(`💭 ${reasoning}`);
	return answer ? `${quoted}\n\n${answer}` : quoted;
}

/** The Telegram identifiers bound to a surface for one turn. */
export interface TelegramReplyTarget {
	chatId: number;
	/** The user message being replied to — the draft id seed (no outbound quote, docs/adr/0021). */
	messageId: number;
}

/** Streams drafts and serializes persistent Telegram sends. */
export class TelegramReplySurface implements ReplySurface {
	private readonly draftSeed: number;
	private segmentIndex = 0;
	private lastDraftMs = 0;
	/** Rate-aware serialized outbound queue for persistent sends (issue #82). */
	private readonly queue: RateAwareQueue;

	constructor(private readonly bot: Bot, private readonly target: TelegramReplyTarget) {
		this.draftSeed = target.messageId || Date.now();
		this.queue = new RateAwareQueue();
	}

	/** This segment's draft id — seed + segment counter, so segments don't collide. */
	private get draftId(): number {
		return this.draftSeed + this.segmentIndex * SEGMENT_DRAFT_STRIDE;
	}

	/** Serialize persistent sends with a bounded 429 retry. Log failures without aborting the turn. */
	private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
		return this.queue.enqueue(fn).catch((error) => {
			console.error({ message: 'Telegram send failed', error });
			return undefined;
		});
	}

	draft(markdown: string): void {
		// Throttle: drop updates that arrive within the window. The first call of a
		// segment (lastDraftMs reset to 0) always sends, so "Thinking…" shows promptly.
		if (Date.now() - this.lastDraftMs < DRAFT_THROTTLE_MS) return;
		this.lastDraftMs = Date.now();

		void this.bot
			.sendRichMessageDraft({ chat_id: this.target.chatId, draft_id: this.draftId, rich_message: { markdown: markdown || THINKING_BLOCK } })
			.catch((error) => console.error({ message: 'Failed to send rich message draft', error }));
	}

	async endSegment(markdown: string, opts: { final: boolean }): Promise<void> {
		// Persist this segment as a Rich Message; only the final answer notifies, so
		// the turn buzzes the phone exactly once. No `reply_parameters`: the Transcript
		// drops the outbound quote-reply (docs/adr/0021); messages stack in order.
		await this.enqueue(() =>
			this.bot.sendRichMessage({
				chat_id: this.target.chatId,
				rich_message: { markdown },
				disable_notification: !opts.final,
			}),
		);
		// Advance to the next segment's draft id and let its "Thinking…" show at once.
		this.segmentIndex++;
		this.lastDraftMs = 0;
	}

	toolStart(name: string, label?: string): ToolMessage {
		// A silent plain message (editable in place by `editMessageText`); the emoji
		// status needs no markdown. Shows the live input `label` (docs/adr/0026) and is
		// edited to its result line (label · summary · duration) when the call resolves.
		const sent = this.enqueue(() =>
			this.bot.sendMessage({
				chat_id: this.target.chatId,
				text: toolStartLine(name, label),
				disable_notification: true,
			}),
		);
		const edit = async (text: string): Promise<void> => {
			await this.enqueue(async () => {
				const message = await sent;
				// The send was dropped (e.g. a 429, swallowed-and-logged) — nothing to edit.
				if (message) await this.bot.editMessageText(this.target.chatId, message.message_id, text);
			});
		};
		return {
			done: ({ summary, durationMs }) => edit(toolLine(name, { label, summary, durationMs })),
			fail: ({ shortError, durationMs }) => edit(toolLine(name, { label, error: shortError, durationMs })),
		};
	}

	async notice(text: string): Promise<void> {
		await this.enqueue(() => this.bot.sendMessage({ chat_id: this.target.chatId, text }));
	}

	async document(trace: DebugTrace): Promise<void> {
		await this.enqueue(() =>
			this.bot.sendDocument(
				this.target.chatId,
				{
					filename: `debug-${this.target.chatId}-${this.target.messageId}.json`,
					content: serializeDebugTrace(trace),
					contentType: 'application/json',
				},
				{ caption: '🐛 Debug trace' },
			),
		);
	}
}

/** Adapt turn events to Telegram, accumulating draft previews and tracking tool-message handles. */
export function makeTelegramEmit(surface: ReplySurface): (event: TurnEvent) => void | Promise<void> {
	const toolHandles = new Map<string, ToolMessage>();
	let reasoning = '';
	let text = '';
	return (event) => {
		switch (event.type) {
			case 'segment-start':
				reasoning = '';
				text = '';
				surface.draft('');
				return;
			case 'text-delta':
				text += event.delta;
				surface.draft(composeDraft(reasoning, text));
				return;
			case 'reasoning-delta':
				reasoning += event.delta;
				surface.draft(composeDraft(reasoning, text));
				return;
			case 'segment':
				return surface.endSegment(event.markdown, { final: event.final });
			case 'tool-start':
				toolHandles.set(event.toolCallId, surface.toolStart(event.name, event.label));
				return;
			case 'tool-done':
				return toolHandles.get(event.toolCallId)?.done({ summary: event.summary, durationMs: event.durationMs });
			case 'tool-fail':
				return toolHandles.get(event.toolCallId)?.fail({ shortError: event.shortError, durationMs: event.durationMs });
			case 'notice':
				return surface.notice(event.text);
			case 'document':
				return surface.document(event.trace);
		}
	};
}
