import { afterEach, describe, expect, it } from 'vitest';
import { RICH_MESSAGE_CHAR_LIMIT, TelegramReplySurface } from '../features/agent/reply-surface';
import { MAX_CHAT_TOKENS } from '../features/ai/model';
import { Bot } from '../core/bot';
import type { SendRichMessageParams } from 'telegram-bot-api-types';
import type { Env } from '../core/env';

describe('MAX_CHAT_TOKENS tripwire', () => {
	it('keeps a worst-case turn under the Rich Message char limit', () => {
		const worstCaseCharsPerToken = 4;
		expect(MAX_CHAT_TOKENS * worstCaseCharsPerToken < RICH_MESSAGE_CHAR_LIMIT).toBe(true);
	});
});

describe('TelegramReplySurface notifications', () => {
	let original: typeof Bot.prototype.sendRichMessage;
	let originalSendMessage: typeof Bot.prototype.sendMessage;
	let sent: SendRichMessageParams[];
	let sentPlain: Array<{ chat_id: number | string; text: string; disable_notification?: boolean }>;

	afterEach(() => {
		if (original) Bot.prototype.sendRichMessage = original;
		if (originalSendMessage) Bot.prototype.sendMessage = originalSendMessage;
	});

	function fakeBot(): Bot {
		sent = [];
		sentPlain = [];
		original = Bot.prototype.sendRichMessage;
		Bot.prototype.sendRichMessage = async function (data: SendRichMessageParams) {
			sent.push(data);
			return { message_id: 1, date: 0, chat: { id: data.chat_id as number, type: 'private' } } as never;
		};
		originalSendMessage = Bot.prototype.sendMessage;
		Bot.prototype.sendMessage = async function (data: { chat_id: number | string; text: string; disable_notification?: boolean }) {
			sentPlain.push(data);
			return { message_id: 1, date: 0, chat: { id: data.chat_id as number, type: 'private' } } as never;
		};
		return new Bot({} as Env);
	}

	it('the final segment notifies', async () => {
		const surface = new TelegramReplySurface(fakeBot(), { chatId: 1, messageId: 1 });
		await surface.endSegment('hello', { final: true });
		expect(sent[0].disable_notification).toBe(false);
	});

	it('a non-final segment stays silent either way', async () => {
		const surface = new TelegramReplySurface(fakeBot(), { chatId: 1, messageId: 1 });
		await surface.endSegment('hello', { final: false });
		expect(sent[0].disable_notification).toBe(true);
	});

	it('the empty-turn/interrupted notice notifies', async () => {
		const surface = new TelegramReplySurface(fakeBot(), { chatId: 1, messageId: 1 });
		await surface.notice('No reply was generated. Please try again.');
		expect(sentPlain[0].disable_notification).toBeUndefined();
	});
});
