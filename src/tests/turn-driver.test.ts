import { describe, it, expect, afterEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { runTurn, type TurnDriverDeps, type TurnDriverInput } from '../features/agent/turn-driver';
import { Bot } from '../core/bot';
import { ChatSettings } from '../features/agent/chat-settings';
import { ToolApprovals, type ApprovalStore, type PendingApproval } from '../features/agent/tool-approvals';
import { makePrincipal } from '../core/principal';
import type { Env } from '../core/env';
import type { ContextBlocks, SqlProvider } from 'agents/context';
import type { Session } from 'agents/sessions';
import type { Memory, AutoRecallHit } from '../features/memory/memory';

/** In-memory `settings` key/value table, driving the real `ChatSettings` (the same class production uses). */
function fakeSettingsSql(): SqlProvider['sql'] {
	const kv = new Map<string, string>();
	return (<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] => {
		const text = strings.join('?').trim();
		if (text.startsWith('CREATE TABLE')) return [];
		if (text.startsWith('SELECT value FROM settings')) {
			const value = kv.get(values[0] as string);
			return (value === undefined ? [] : [{ value }]) as T[];
		}
		if (text.startsWith('INSERT INTO settings')) {
			kv.set(values[0] as string, values[1] as string);
			return [];
		}
		if (text.startsWith('DELETE FROM settings')) {
			kv.delete(values[0] as string);
			return [];
		}
		return [];
	}) as SqlProvider['sql'];
}

/** In-memory STATE binding. */
function fakeKV(): KVNamespace {
	const raw = new Map<string, string>();
	return {
		get: async (key: string, type?: string) => {
			const value = raw.get(key);
			if (value === undefined) return null;
			return type === 'json' ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => {
			raw.set(key, value);
		},
		delete: async (key: string) => {
			raw.delete(key);
		},
	} as unknown as KVNamespace;
}

/** A D1 stub returning empty results for every query shape drizzle's D1 driver issues (`.all()`/`.raw()`/`.run()`) — enough for `mcpRegistry.listEnabled` to resolve to `[]` with no real Durable Object or database. */
function fakeD1(): D1Database {
	const stmt = {
		bind: () => stmt,
		all: async () => ({ results: [], success: true, meta: {} }),
		raw: async () => [],
		run: async () => ({ results: [], success: true, meta: {} }),
		first: async () => null,
	};
	return { prepare: () => stmt } as unknown as D1Database;
}

/** A Sandbox DO namespace stub — `getSandbox` only calls `.idFromName`/`.get` synchronously and fire-and-forgets a `.configure`/`.setSandboxName` call the stub can safely lack (docs/adr/0019). */
function fakeSandboxNamespace(): DurableObjectNamespace {
	return {
		idFromName: (name: string) => name,
		get: () => ({}),
	} as unknown as DurableObjectNamespace;
}

interface FakeEnvOptions {
	model: MockLanguageModelV3;
	kv?: KVNamespace;
}

function fakeEnv({ model, kv = fakeKV() }: FakeEnvOptions): Env {
	return {
		DB: fakeD1(),
		STATE: kv,
		FEEDS: {} as unknown as KVNamespace,
		Sandbox: fakeSandboxNamespace(),
		AI: {} as unknown as Env['AI'],
		DEEPSEEK_API_KEY: '',
		BOT_TIMEZONE: 'UTC',
		CHAT_MODEL: model,
	} as unknown as Env;
}

/** `agent.mcp` reconciles against an empty registry (`fakeD1`'s empty rows) and reports no MCP tools — the opaque handle `runTurn` forwards untouched to `runAgenticTurn`. */
function fakeMcpAgent(): TurnDriverDeps['agent'] {
	return {
		mcp: { mcpConnections: {}, getAITools: () => ({}) },
		addMcpServer: async () => ({ id: 'unused' }) as never,
		removeMcpServer: async () => {},
	} as unknown as TurnDriverDeps['agent'];
}

/** The recorder surface (docs/adr/0047 Phase 3): a fake `Session` recording every `appendMessage`. */
function fakeSession(opts: { history?: unknown[] } = {}): Session & { appended: unknown[] } {
	const appended: unknown[] = [];
	return {
		appended,
		getRecentHistory: vi.fn(async () => ({ messages: opts.history ?? [], truncated: false })),
		appendMessage: async (msg: unknown) => {
			appended.push(msg);
		},
	} as unknown as Session & { appended: unknown[] };
}

function fakeContext(baseSystem = 'BASE SYSTEM PROMPT'): ContextBlocks {
	return {
		freezeSystemPrompt: async () => baseSystem,
		tools: async () => ({}),
	} as unknown as ContextBlocks;
}

function fakeMemory(hits: AutoRecallHit[] = []): Memory {
	return { autoRecall: async () => hits } as unknown as Memory;
}

function fakeApprovalStore(): ApprovalStore & { rows: Map<string, PendingApproval> } {
	const rows = new Map<string, PendingApproval>();
	return {
		rows,
		insert: (row) => void rows.set(row.id, row),
		getById: (id) => rows.get(id) ?? null,
		deleteById: (id) => void rows.delete(id),
		deleteAll: () => void rows.clear(),
	};
}

const originalBotMethods = {
	sendMessage: Bot.prototype.sendMessage,
	sendRichMessage: Bot.prototype.sendRichMessage,
	editMessageText: Bot.prototype.editMessageText,
};

afterEach(() => {
	Bot.prototype.sendMessage = originalBotMethods.sendMessage;
	Bot.prototype.sendRichMessage = originalBotMethods.sendRichMessage;
	Bot.prototype.editMessageText = originalBotMethods.editMessageText;
	vi.restoreAllMocks();
});

/** Monkeypatch `Bot.prototype` the way `reply-surface.test.ts` does — `TelegramReplySurface` calls real `Bot` methods internally, so a duck-typed fake object isn't enough. */
function fakeBot(): { bot: Bot; sentPlain: Array<{ chat_id: number | string; text: string; disable_notification?: boolean }> } {
	const sentPlain: Array<{ chat_id: number | string; text: string; disable_notification?: boolean }> = [];
	Bot.prototype.sendMessage = async function (data: { chat_id: number | string; text: string; disable_notification?: boolean }) {
		sentPlain.push(data);
		return { message_id: 1, date: 0, chat: { id: data.chat_id as number, type: 'private' } } as never;
	};
	Bot.prototype.sendRichMessage = async function (data: { chat_id: number | string; disable_notification?: boolean }) {
		return { message_id: 1, date: 0, chat: { id: data.chat_id as number, type: 'private' } } as never;
	};
	Bot.prototype.editMessageText = async function () {
		return true as never;
	};
	return { bot: new Bot({} as Env), sentPlain };
}

/** Builds `TurnDriverDeps` from the individual fakes a test wants to control, defaulting everything else to an inert stand-in. */
function makeDeps(overrides: Partial<TurnDriverDeps> & { env: Env; settings: ChatSettings; bot: Bot }): TurnDriverDeps {
	return {
		agent: fakeMcpAgent(),
		traceConversationId: 'opaque-do-id',
		session: fakeSession(),
		compactHistory: async () => {},
		context: fakeContext(),
		memory: () => fakeMemory(),
		sandbox: () => ({}) as never,
		sandboxUsage: () => ({}) as never,
		toolApprovals: () => new ToolApprovals({ store: fakeApprovalStore() }),
		scheduledTurns: () => ({}) as never,
		deepTaskLauncher: () => ({}) as never,
		resolvePrincipal: async (senderId, chatId) => makePrincipal(senderId, chatId, 'member'),
		recordUsage: () => {},
		...overrides,
	};
}

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textOnlyStream() {
	return {
		stream: new ReadableStream({
			start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				controller.enqueue({ type: 'text-start', id: '1' });
				controller.enqueue({ type: 'text-delta', id: '1', delta: 'ok' });
				controller.enqueue({ type: 'text-end', id: '1' });
				controller.enqueue({ type: 'finish', finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE });
				controller.close();
			},
		}),
	};
}

function toolCallStream(toolName: string, args: Record<string, unknown>) {
	return {
		stream: new ReadableStream({
			start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				controller.enqueue({
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName,
					input: JSON.stringify(args),
				});
				controller.enqueue({
					type: 'finish',
					finishReason: { unified: 'tool-calls' as const, raw: undefined },
					usage: USAGE,
				});
				controller.close();
			},
		}),
	};
}

const BASE_INPUT: Omit<TurnDriverInput, 'chatId'> = {
	text: 'hello',
	replyToMessageId: 1,
	userId: 42,
};

describe('runTurn — language append', () => {
	it("appends the chat's Language preference to the system prompt", async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		settings.language = 'Français';
		const { bot } = fakeBot();

		await runTurn(makeDeps({ env, settings, bot, context: fakeContext('BASE') }), {
			...BASE_INPUT,
			chatId: -100123,
		});

		const call = model.doStreamCalls[0];
		expect(JSON.stringify(call.prompt)).toContain('Reply in this language: Français');
	});

	it('leaves the system prompt untouched when no language is set', async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();

		await runTurn(makeDeps({ env, settings, bot, context: fakeContext('BASE') }), {
			...BASE_INPUT,
			chatId: -100123,
		});

		const call = model.doStreamCalls[0];
		expect(JSON.stringify(call.prompt)).not.toContain('Reply in this language');
	});
});

describe('runTurn — auto-recall preamble', () => {
	it("injects recalled memories as a preamble on the turn's message, not the persisted one", async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();
		const hit: AutoRecallHit = { text: 'User prefers dark mode', ts: 1000, lastSeenTs: 1000, score: 0.9 };
		const session = fakeSession();

		await runTurn(makeDeps({ env, settings, bot, session, memory: () => fakeMemory([hit]) }), {
			...BASE_INPUT,
			chatId: -100123,
		});

		const call = model.doStreamCalls[0];
		expect(JSON.stringify(call.prompt)).toContain('User prefers dark mode');
		expect(JSON.stringify(call.prompt)).toContain('Recalled from long-term memory');
		// The Session only ever sees the raw text (docs/adr/0038: recalled facts
		// never enter history, or compaction could mine them back into memory).
		const appendedUser = session.appended.find((m) => JSON.stringify(m).includes('"role":"user"'));
		expect(JSON.stringify(appendedUser)).not.toContain('Recalled from long-term memory');
	});
});

describe('runTurn — toolset', () => {
	it('includes schedule/deep-task/run_shell for a schedule_turns holder', async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();

		await runTurn(makeDeps({ env, settings, bot }), { ...BASE_INPUT, chatId: -100123 });

		const toolNames = (model.doStreamCalls[0].tools ?? []).map((t) => t.name);
		expect(toolNames).toContain('run_shell');
		expect(toolNames).toContain('schedule_turn');
		expect(toolNames).toContain('deep_task');
	});
});

describe('runTurn — approval request', () => {
	it('sends the approval request normally', async () => {
		const model = new MockLanguageModelV3({ doStream: [toolCallStream('run_shell', { command: 'echo hi' }), textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot, sentPlain } = fakeBot();

		await runTurn(makeDeps({ env, settings, bot }), { ...BASE_INPUT, chatId: -100123 });

		const request = sentPlain.find((m) => /Approval required/.test(m.text));
		expect(request).toBeDefined();
		expect(request?.disable_notification).toBeFalsy();
	});
});

describe('runTurn — onReply persistence', () => {
	it("appends the user then assistant message to the Session on a successful reply", async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();
		const session = fakeSession();

		await runTurn(makeDeps({ env, settings, bot, session }), { ...BASE_INPUT, chatId: -100123, text: 'hi there' });

		expect(session.appended).toHaveLength(2);
		expect(JSON.stringify(session.appended[0])).toContain('"role":"user"');
		expect(JSON.stringify(session.appended[1])).toContain('"role":"assistant"');
	});
});

describe('runTurn — error path', () => {
	it('a stream error is observed by onError and never thrown out of runTurn', async () => {
		const model = new MockLanguageModelV3({
			doStream: [
				{
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: 'stream-start', warnings: [] });
							controller.enqueue({ type: 'error', error: new Error('boom') });
							controller.enqueue({
								type: 'finish',
								finishReason: { unified: 'error' as const, raw: undefined },
								usage: USAGE,
							});
							controller.close();
						},
					}),
				},
			],
		});
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();
		const errors: unknown[] = [];

		await expect(
			runTurn(makeDeps({ env, settings, bot }), {
				...BASE_INPUT,
				chatId: -100123,
				onError: (error) => {
					errors.push(error);
				},
			})
		).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe('boom');
	});
});


describe('runTurn — Telegram attachments', () => {
	it('sends original image bytes with the caption, and restores them for a text-only follow-up', async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream(), textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();
		vi.spyOn(bot, 'sendChatAction').mockResolvedValue(true);
		vi.spyOn(bot, 'getFile').mockResolvedValue({ file_id: 'photo', file_unique_id: 'unique', file_path: 'private-path' });
		vi.spyOn(bot, 'downloadFile').mockResolvedValue(new Blob(['original pixels']).stream());
		const session = fakeSession();
		await runTurn(makeDeps({ env, settings, bot, session }), {
			...BASE_INPUT, chatId: 42, text: '图上写了什么？',
			attachment: { fileId: 'photo', name: 'photo.jpg', mediaType: 'image/jpeg' },
		});
		expect(model.doStreamCalls[0].prompt).toContainEqual({ role: 'user', content: [
			{ type: 'text', text: '图上写了什么？' },
			{ type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'b3JpZ2luYWwgcGl4ZWxz' }, filename: 'photo.jpg' },
		] });
		expect(JSON.stringify(session.appended[0])).toContain('data:image/jpeg;base64,b3JpZ2luYWwgcGl4ZWxz');
		expect(JSON.stringify(session.appended)).not.toMatch(/private-path|image description/);
		expect(session.getRecentHistory).toHaveBeenCalledWith(16 * 1024 * 1024);
		await runTurn(makeDeps({ env, settings, bot, session: fakeSession({ history: session.appended }) }), {
			...BASE_INPUT, chatId: 42, text: '再看一下左下角',
		});
		expect(model.doStreamCalls[1].prompt).toContainEqual(model.doStreamCalls[0].prompt.find((m) => m.role === 'user'));
		expect(bot.downloadFile).toHaveBeenCalledTimes(1);
	});

	it('tells the model when older images fall outside the history byte budget', async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream()] });
		const env = fakeEnv({ model });
		const session = fakeSession();
		vi.mocked(session.getRecentHistory).mockResolvedValue({ messages: [], truncated: true, totalContentBytes: 20 * 1024 * 1024 });
		const { bot } = fakeBot();
		await runTurn(makeDeps({ env, settings: new ChatSettings({ sql: fakeSettingsSql() }), bot, session }), { ...BASE_INPUT, chatId: 42 });
		expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('Ask the user to resend an image');
	});

	it('preserves text-only scheduled group turns whose usage identity is the chat ID', async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();
		await runTurn(makeDeps({ env, settings, bot, resolvePrincipal: async () => makePrincipal(-100, -100, 'stranger') }), {
			...BASE_INPUT, chatId: -100, userId: -100, text: 'Scheduled reminder',
		});
		expect(model.doStreamCalls).toHaveLength(1);
	});

	it('passes the caption and extracted content to the model and retains it for a later turn', async () => {
		const model = new MockLanguageModelV3({ doStream: [textOnlyStream(), textOnlyStream()] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();
		vi.spyOn(bot, 'sendChatAction').mockResolvedValue(true);
		vi.spyOn(bot, 'getFile').mockResolvedValue({ file_id: 'doc', file_unique_id: 'unique', file_path: 'private-path' });
		vi.spyOn(bot, 'downloadFile').mockResolvedValue(new Blob(['Invoice total: 123 CNY']).stream());
		const session = fakeSession();
		await runTurn(makeDeps({ env, settings, bot, session }), {
			...BASE_INPUT, chatId: 42, text: '这张账单多少钱？',
			attachment: { fileId: 'doc', name: 'invoice.txt', mediaType: 'text/plain' },
		});
		expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('这张账单多少钱？');
		expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('Invoice total: 123 CNY');
		expect(JSON.stringify(session.appended[0])).toContain('Invoice total: 123 CNY');
		expect(JSON.stringify(session.appended)).not.toContain('private-path');
		await runTurn(makeDeps({ env, settings, bot, session: fakeSession({ history: session.appended }) }), {
			...BASE_INPUT, chatId: 42, text: '币种是什么？',
		});
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('Invoice total: 123 CNY');
		expect(bot.downloadFile).toHaveBeenCalledTimes(1);
	});

	it('reports unreadable attachments without invoking the model or writing history', async () => {
		const model = new MockLanguageModelV3({ doStream: [] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot, sentPlain } = fakeBot();
		vi.spyOn(bot, 'sendChatAction').mockResolvedValue(true);
		const session = fakeSession();
		await runTurn(makeDeps({ env, settings, bot, session }), {
			...BASE_INPUT, chatId: 42,
			attachment: { fileId: 'zip', name: 'archive.zip', mediaType: 'application/zip' },
		});
		expect(sentPlain[0].text).toContain('Unsupported file type');
		expect(model.doStreamCalls).toHaveLength(0);
		expect(session.appended).toHaveLength(0);
	});

	it('does not download or call AI when access was revoked while the turn was queued', async () => {
		const model = new MockLanguageModelV3({ doStream: [] });
		const env = fakeEnv({ model });
		const settings = new ChatSettings({ sql: fakeSettingsSql() });
		const { bot } = fakeBot();
		const download = vi.spyOn(bot, 'downloadFile');
		await runTurn(makeDeps({ env, settings, bot, resolvePrincipal: async () => makePrincipal(42, 42, 'stranger') }), {
			...BASE_INPUT, chatId: 42,
			attachment: { fileId: 'photo', name: 'photo.jpg', mediaType: 'image/jpeg' },
		});
		expect(download).not.toHaveBeenCalled();
		expect(model.doStreamCalls).toHaveLength(0);
	});
});
