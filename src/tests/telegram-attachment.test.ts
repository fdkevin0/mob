import { describe, it, expect, vi } from 'vitest';
import { readTelegramAttachment, telegramAttachment, type TelegramAttachment } from '../features/agent/telegram-attachment';

const attachment: TelegramAttachment = { fileId: 'file-secret', name: 'notes.txt', mediaType: 'text/plain' };

function fakes(content = 'Meeting notes') {
	return {
		bot: {
			getFile: vi.fn(async () => ({ file_id: 'file-secret', file_unique_id: 'unique', file_path: 'private-path' })),
			downloadFile: vi.fn(async () => new Blob([content]).stream()),
		},
		ai: { toMarkdown: vi.fn(async () => [{ format: 'markdown', data: 'A red bicycle' }]) } as unknown as Pick<Ai, 'toMarkdown'>,
	};
}

describe('Telegram attachment input', () => {
	it('selects the largest photo without mutating the Telegram update and recognizes document MIME fallbacks', () => {
		const photo = [
			{ file_id: 'small', file_unique_id: 'a', width: 100, height: 100 },
			{ file_id: 'large', file_unique_id: 'b', width: 400, height: 300 },
		];
		expect(telegramAttachment({ photo })).toMatchObject({ fileId: 'large', mediaType: 'image/jpeg' });
		expect(photo[0].file_id).toBe('small');
		expect(telegramAttachment({ document: { file_id: 'pdf', file_unique_id: 'c', file_name: 'REPORT.PDF', mime_type: 'application/octet-stream' } }))
			.toMatchObject({ name: 'REPORT.PDF', mediaType: 'application/pdf' });
	});

	it('decodes UTF-8 text locally and never includes Telegram identifiers or download paths in model context', async () => {
		const { bot, ai } = fakes('中文笔记');
		const result = await readTelegramAttachment(bot, ai, attachment);
		expect(result).toHaveProperty('part.text', expect.stringContaining('中文笔记'));
		expect(JSON.stringify(result)).not.toMatch(/file-secret|private-path/);
		expect(ai.toMarkdown).not.toHaveBeenCalled();
	});

	it.each(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])(
		'converts %s using the existing AI binding', async (mediaType) => {
			const { bot, ai } = fakes();
			const result = await readTelegramAttachment(bot, ai, { ...attachment, mediaType });
			expect(ai.toMarkdown).toHaveBeenCalledWith([{ name: 'notes.txt', blob: expect.any(Blob) }]);
			expect(result).toHaveProperty('part.text', expect.stringContaining('A red bicycle'));
		},
	);

	it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])('passes %s bytes unchanged as an inline file, without image captioning', async (mediaType) => {
		const { bot, ai } = fakes('original image bytes');
		expect(await readTelegramAttachment(bot, ai, { ...attachment, mediaType })).toEqual({ part: {
			type: 'file', mediaType, filename: 'notes.txt', url: `data:${mediaType};base64,b3JpZ2luYWwgaW1hZ2UgYnl0ZXM=`,
		} });
		expect(ai.toMarkdown).not.toHaveBeenCalled();
	});

	it.each(['image/bmp', 'image/svg+xml'])('rejects %s instead of falling back to a description', async (mediaType) => {
		const { bot, ai } = fakes();
		expect(await readTelegramAttachment(bot, ai, { ...attachment, mediaType })).toHaveProperty('error');
		expect(bot.downloadFile).not.toHaveBeenCalled();
		expect(ai.toMarkdown).not.toHaveBeenCalled();
	});

	it('rejects unsupported files and declared oversized attachments before downloading', async () => {
		const { bot, ai } = fakes();
		expect(await readTelegramAttachment(bot, ai, { ...attachment, mediaType: 'application/zip' })).toHaveProperty('error');
		expect(await readTelegramAttachment(bot, ai, { ...attachment, size: 11 * 1024 * 1024 })).toHaveProperty('error');
		expect(bot.getFile).not.toHaveBeenCalled();
	});

	it('enforces the actual byte limit even when Telegram omits the size, cancelling the stream', async () => {
		const { bot, ai } = fakes();
		const cancel = vi.fn();
		bot.downloadFile.mockResolvedValue(new ReadableStream({
			start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); },
			cancel,
		}));
		expect(await readTelegramAttachment(bot, ai, attachment)).toHaveProperty('error', expect.stringContaining('10 MiB'));
		expect(cancel).toHaveBeenCalled();
		expect(ai.toMarkdown).not.toHaveBeenCalled();
	});

	it.each(['', 'x'.repeat(40_001), 'binary\0data'])(
		'rejects empty, overly long or binary text without silently truncating it', async (content) => {
			const { bot, ai } = fakes(content);
			expect(await readTelegramAttachment(bot, ai, attachment)).toHaveProperty('error');
		},
	);

	it('returns safe errors for conversion failure without reflecting provider details', async () => {
		const { bot, ai } = fakes();
		vi.mocked(ai.toMarkdown).mockResolvedValueOnce([{ format: 'error', error: 'private content and credentials' }] as never);
		expect(await readTelegramAttachment(bot, ai, { ...attachment, mediaType: 'application/pdf' })).toEqual({
			error: 'Could not read this document. Try exporting it as UTF-8 text.',
		});
	});
});
