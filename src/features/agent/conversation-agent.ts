import { compactSessionText } from '../ai/session-compaction';
import { telegramAttachment, type TelegramAttachment } from './telegram-attachment';
import { Agent, type AgentContext } from 'agents';
import { AgentContextProvider, ContextBlocks } from 'agents/context';
import { Sessions, createCompactFunction } from 'agents/sessions';
import { stepCountIs } from 'ai';
import { getSandbox } from '@cloudflare/sandbox';
import type * as Telegram from 'telegram-bot-api-types';
import { Bot } from '../../core/bot';
import type { Env } from '../../core/env';
import { resolvePrincipal } from '../../core/principal';
import { SYSTEM_PROMPT } from '../ai/agentic';
import { aiTrace, getAISDK } from '../ai/sdk';
import { runTurn as runTurnDriver, type TurnDriverDeps } from './turn-driver';
import { generateUtility } from '../ai/utility-model';
import { userMessage, assistantMessage } from '../ai/session-messages';
import { DEFAULT_CHAT_MODEL, MAX_CHAT_TOKENS, resolveModel } from '../ai/model';
import type { ReasoningEffort } from '../ai/reasoning-effort';
import { emailRepository } from '../email/repository';
import { EmailReply, type ArmReplyInput, type ReplyActionResult, type ReplyState, type ReplyStateChange } from '../email/email-reply';
import { buildBuiltinTools } from './tools';
import { buildQuotedText, prependQuote } from './quote';
import { Memory, type MemoryStore, type StoredMemory, type VectorIndex, type VectorMatch } from '../memory/memory';
import { runExtraction } from '../memory/extraction';
import { createAsset } from '../assets/assets';
import { SandboxUsage, type SandboxUsageStore, type SandboxUsageReport, sandboxDailyLimitMs } from './sandbox-usage';
import { ScheduledTurns, cancelPendingTurnAlarms, type OccurrenceScheduler, type ScheduledTurnView } from './scheduled-turns';
import {
	ToolApprovals,
	renderContinuationPrompt,
	renderDenialNote,
	type ApprovalStore,
	type DecideResult,
} from './tool-approvals';
import {
	DeepTasks,
	composeDeepTaskDelivery,
	renderDeepTaskProgress,
	renderDeepTaskSettled,
	type DeepTaskEnd,
	type DeepTaskStore,
} from './deep-tasks';
import type { DeepTaskLauncher } from './tools/deep-task';
import { UsageLedger, type UsageKind, type UsageLedgerStore, type UsageLike, type UsageReport } from './usage-ledger';
import { ChatSettings } from './chat-settings';
import { createStoreDb, ensureStoreSchema, type StoreDb } from './stores/db';
import { createScheduledTurnStore } from './stores/scheduled-turn-store';
import { createToolApprovalStore } from './stores/tool-approval-store';
import { createDeepTaskStore } from './stores/deep-task-store';
import { createSandboxUsageStore } from './stores/sandbox-usage-store';
import { createUsageLedgerStore } from './stores/usage-ledger-store';
import { createMemoryStore } from './stores/memory-store';
import { createEmailReplyStore, type EmailReplyStore } from './stores/email-reply-store';
import { recentFeedEntries } from '../feed/recent';

/** Bump whenever the background deep-task prompt contract changes. */
const DEEP_TASK_PROMPT_VERSION = 'deep-task-2026-09-02.1';

/** Workers AI multilingual embedding model for Long-term memory (docs/adr/0015). */
const EMBEDDING_MODEL = '@cf/baai/bge-m3';

/** Telegram's hard `sendMessage` text cap — the email confirm path's real limit. */
const SEND_MESSAGE_TEXT_LIMIT = 4096;

type Stores = {
	memory: MemoryStore;
	scheduledTurns: ReturnType<typeof createScheduledTurnStore>;
	approvals: ApprovalStore;
	deepTasks: DeepTaskStore;
	usageLedger: UsageLedgerStore;
	emailReply: EmailReplyStore;
	sandboxUsage: (userId: number) => SandboxUsageStore;
};

/** All context-writing work is serialized through the SDK queue (ADR-0028). */
type QueuedTurn =
	| { kind: 'chat'; text: string; chatId: number; replyToMessageId: number; userId: number; attachment?: TelegramAttachment }
	| { kind: 'fire'; taskId: string }
	| { kind: 'approval'; toolName: string; argsJson: string; chatId: number; replyToMessageId: number; userId: number }
	| { kind: 'deny-note'; toolName: string; argsJson: string; chatId: number }
	| {
			kind: 'deep-delivery';
			chatId: number;
			taskId: string;
			description: string;
			prompt: string;
			startMessageId: number | null;
			body: string;
			end: DeepTaskEnd;
			error?: string;
	  };

/** One conversation Durable Object; owns queueing, history, stores, and delivery. */
export class ConversationAgent extends Agent<Env> {
	private readonly sessions = new Sessions();
	private readonly promptContext = new ContextBlocks(
		[
			{ label: 'identity', provider: { get: async () => SYSTEM_PROMPT } },
			{
				label: 'memory',
				description: 'Durable notes the assistant has written about the user and this chat.',
				provider: new AgentContextProvider(this, 'memory'),
			},
		],
		new AgentContextProvider(this, '_system_prompt'),
	);
	private readonly chatSession = this.sessions.session();
	private readonly compactText = createCompactFunction({
		summarize: async (prompt) => {
			const chatId = Number(this.name);
			const result = await generateUtility(
				this.env,
				{ prompt },
				{ functionId: 'conversation-agent.compaction', conversationId: this.ctx.id.toString() },
			);
			// Compaction is an unattended call, attributed to the chat (PRD #100).
			this.recordUsage(chatId, 'compaction', DEFAULT_CHAT_MODEL, result.usage);
			// Fact extraction (docs/adr/0038): compaction is the extraction
			// trigger — mine the summary off the critical path; best-effort,
			// never fails or delays the compaction that hosted it.
			this.scheduleFactExtraction(result.text, chatId);
			return result.text;
		},
	});

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.sessions);
	}

	/** Lazily-constructed typed accessor over the key/value `settings` table. */
	private _settings: ChatSettings | undefined;

	private get settings(): ChatSettings {
		return (this._settings ??= new ChatSettings(this));
	}

	private __storeDb: StoreDb | undefined;
	private get storeDb(): StoreDb {
		return (this.__storeDb ??= (() => {
			const db = createStoreDb(this.ctx.storage);
			ensureStoreSchema(db);
			return db;
		})());
	}

	private _stores: Stores | undefined;
	private get stores(): Stores {
		return (this._stores ??= {
			memory: createMemoryStore(this.storeDb),
			scheduledTurns: createScheduledTurnStore(this.storeDb),
			approvals: createToolApprovalStore(this.storeDb),
			deepTasks: createDeepTaskStore(this.storeDb),
			usageLedger: createUsageLedgerStore(this.storeDb),
			emailReply: createEmailReplyStore(this.storeDb),
			sandboxUsage: (userId) => createSandboxUsageStore(this.storeDb, userId),
		});
	}

	async onTelegramMessage(update: Telegram.Update): Promise<void> {
		const msg = update.message;
		if (!msg) return;
		const attachment = telegramAttachment(msg);
		if (typeof msg.text !== 'string' && !attachment) return;
		const text = msg.text ?? msg.caption?.trim() ?? '';
		return this.handleTelegramMessage(msg, text || 'Summarize this attachment and offer to answer follow-up questions.', msg.chat.id, attachment);
	}

	private async handleTelegramMessage(msg: NonNullable<Telegram.Update['message']>, messageText: string, chatId: number, attachment?: TelegramAttachment): Promise<void> {
		const pendingReply = this.stores.emailReply.get();
		if (pendingReply && !attachment) {
			await this.draftReply(pendingReply, messageText, new Bot(this.env), chatId);
			return;
		}

		// Quoted reply (docs/adr/0015): if this message replies to another, bring the
		// quoted text into the turn so the model knows what's being replied to.
		const quoted = buildQuotedText(msg);
		const text = quoted ? prependQuote(quoted, messageText) : messageText;
		// The sender scopes the per-user sandbox budget (issue #77); fall back to the
		// chat id when `from` is absent (e.g. channel posts), so the cap still applies.
		const userId = msg.from?.id ?? chatId;
		await this.enqueueChatTurn(text, chatId, msg.message_id, userId, attachment);
	}

	/** Run the URL quick action as a normal turn so `fetch_url` remains observable. */
	async askUrl(url: string, chatId: number, replyToMessageId: number, userId: number): Promise<void> {
		const text = `Read this web page and summarize it, then offer to answer follow-up questions about it: ${url}`;
		await this.enqueueChatTurn(text, chatId, replyToMessageId, userId);
	}

	/** Queue once; retrying a failed model turn could duplicate its side effects. */
	private async enqueueChatTurn(text: string, chatId: number, replyToMessageId: number, userId: number, attachment?: TelegramAttachment): Promise<void> {
		const payload: QueuedTurn = { kind: 'chat', text, chatId, replyToMessageId, userId, ...(attachment ? { attachment } : {}) };
		await this.queue('runQueuedTurn', payload, { retry: { maxAttempts: 1 } });
	}

	/** SDK queue callback; all queued history writes pass through here. */
	async runQueuedTurn(payload: QueuedTurn): Promise<void> {
		switch (payload.kind) {
			case 'chat':
				return runTurnDriver(this.turnDriverDeps(), payload);
			case 'fire':
				return this.fireScheduledTurn(payload.taskId);
			case 'approval':
				return this.runApprovedTool(payload);
			case 'deny-note':
				return this.appendDenialNote(payload);
			case 'deep-delivery':
				return this.deliverDeepTask(payload);
		}
	}

	/** Enqueue alarm firings so they serialize with user turns. */
	async onScheduledTurnAlarm(payload: { taskId: string }): Promise<void> {
		await this.queue('runQueuedTurn', { kind: 'fire', taskId: payload.taskId } satisfies QueuedTurn, {
			retry: { maxAttempts: 1 },
		});
	}

	/** Reschedule before running; report failures visibly without retrying tool side effects. */
	private async fireScheduledTurn(taskId: string): Promise<void> {
		const chatId = Number(this.name);
		const turns = this.scheduledTurns();
		const fired = await turns.beginFire(taskId, new Date());
		if (!fired) return;

		const bot = new Bot(this.env);
		const header = await bot
			.sendMessage({ chat_id: chatId, text: `⏰ ${fired.task.description}`, disable_notification: true })
			.catch((error) => {
				console.error({ message: 'Failed to send scheduled-turn header', error });
				return undefined;
			});

		const text = `[scheduled: ${fired.task.description}] ${fired.task.prompt}`;
		let failure: string | null = null;
		await this.runChatTurn(text, chatId, header?.message_id ?? 0, chatId, (error) => {
			failure = error instanceof Error ? error.message : String(error);
		});

		if (failure) {
			turns.completeFire(taskId, { ok: false, error: failure });
			await bot
				.sendMessage({ chat_id: chatId, text: `⚠️ scheduled turn "${fired.task.description}" failed: ${failure}` })
				.catch((error) => console.error({ message: 'Failed to send scheduled-turn failure notice', error }));
		} else {
			turns.completeFire(taskId, { ok: true });
		}
	}

	/** Run a prepared turn; scheduled firings observe stream errors to report failure. */
	private async runChatTurn(
		text: string,
		chatId: number,
		replyToMessageId: number,
		userId: number,
		onError?: (error: unknown) => void,
	): Promise<void> {
		await runTurnDriver(this.turnDriverDeps(), { text, chatId, replyToMessageId, userId, onError });
	}

	/** Expose chat-scoped dependencies while retaining SQL and queue ownership in the agent. */
	private turnDriverDeps(): TurnDriverDeps {
		return {
			env: this.env,
			agent: this,
			traceConversationId: this.ctx.id.toString(),
			settings: this.settings,
			session: this.chatSession,
			compactHistory: () => this.compactHistory(),
			context: this.promptContext,
			memory: (chatId) => this.memory(chatId),
			sandbox: (id) => getSandbox(this.env.Sandbox, id),
			sandboxUsage: (userId) => this.sandboxUsage(userId),
			toolApprovals: () => this.toolApprovals(),
			scheduledTurns: () => this.scheduledTurns(),
			deepTaskLauncher: (chatId, userId) => this.deepTaskLauncher(chatId, userId),
			bot: new Bot(this.env),
			resolvePrincipal: (senderId, chatId) => resolvePrincipal(senderId, chatId, this.env),
			recordUsage: (userId, kind, model, usage) => this.recordUsage(userId, kind, model, usage),
		};
	}

	private async compactHistory(): Promise<void> {
		await compactSessionText(this.chatSession, this.settings.compactionThreshold, this.compactText);
	}

	/**
	 * One **extraction run** (docs/adr/0038), detached via `waitUntil`: mine the
	 * compaction summary for durable facts (`ingestFact` dedups/confirms/promotes)
	 * and prune decayed working facts in the same pass.
	 */
	private scheduleFactExtraction(summary: string, chatId: number): void {
		const memory = this.memory(chatId);
		const run = runExtraction(summary, {
			// Use the shared model with thinking disabled for fact extraction.
			generate: (prompt) =>
				generateUtility(
					this.env,
					{ prompt },
					{
						functionId: 'conversation-agent.extraction',
						conversationId: this.ctx.id.toString(),
					},
				).then((result) => {
					this.recordUsage(chatId, 'extraction', DEFAULT_CHAT_MODEL, result.usage);
					return result.text;
				}),
			ingest: (fact) => memory.ingestFact(fact),
			decay: () => memory.decay(),
		})
			.then(({ facts, pruned }) => console.info({ message: 'Fact extraction run', chatId, factCount: facts.length, pruned }))
			.catch((error) => console.error({ message: 'Fact extraction failed', chatId, error }));
		this.ctx.waitUntil(run);
	}

	/** Chat-scoped SQLite facts and Vectorize retrieval using the configured result count. */
	private memory(chatId: number): Memory {
		const store = this.stores.memory;

		const index: VectorIndex = {
			upsert: async (id, values, metadata) => {
				await this.env.MEMORIES.upsert([{ id, values, metadata: metadata as VectorizeVector['metadata'] }]);
			},
			query: async (values, options): Promise<VectorMatch[]> => {
				const result = await this.env.MEMORIES.query(values, {
					topK: options.topK,
					filter: options.filter as VectorizeVectorMetadataFilter,
				});
				return result.matches.map((match) => ({ id: match.id, score: match.score }));
			},
			deleteByIds: async (ids) => {
				await this.env.MEMORIES.deleteByIds(ids);
			},
		};

		const embed = async (text: string): Promise<number[]> => {
			const result = (await this.env.AI.run(EMBEDDING_MODEL as never, { text: [text] } as never)) as unknown as {
				data: number[][];
			};
			return result.data[0];
		};

		return new Memory({ chatId, store, index, embed, topK: this.settings.memoryTopK });
	}

	/** Per-user sandbox budget within this chat, shared by code and shell. */
	private sandboxUsage(userId: number): SandboxUsage {
		const store = this.stores.sandboxUsage(userId);
		return new SandboxUsage({ store, limitMs: sandboxDailyLimitMs(this.env.SANDBOX_DAILY_LIMIT_SECONDS) });
	}

	/** Current UTC-day sandbox usage for this user in this chat. */
	async sandboxUsageReport(userId: number): Promise<SandboxUsageReport> {
		const usage = this.sandboxUsage(userId);
		return {
			usedMs: usage.usedMs(),
			remainingMs: usage.remainingMs(),
			limitMs: sandboxDailyLimitMs(this.env.SANDBOX_DAILY_LIMIT_SECONDS),
		};
	}

	/** Adapt SDK alarm registration to ScheduledTurns. */
	private scheduledTurns(): ScheduledTurns {
		return new ScheduledTurns({
			store: this.stores.scheduledTurns,
			scheduler: this.occurrenceScheduler(),
			defaultTimezone: this.env.BOT_TIMEZONE ?? 'UTC',
		});
	}

	/** Replace pending occurrences using the SDK schedule records themselves. */
	private occurrenceScheduler(): OccurrenceScheduler {
		return {
			register: async (taskId, at) => {
				await cancelPendingTurnAlarms(this, taskId);
				// `maxAttempts: 1`, matching `runQueuedTurn`'s own queue options (docs/adr/0028):
				// without it the SDK retries a throwing `onScheduledTurnAlarm` invocation up
				// to 3 times by default, which would re-enqueue the same firing more than once.
				await this.schedule(at, 'onScheduledTurnAlarm', { taskId }, { retry: { maxAttempts: 1 } });
			},
			cancelPending: (taskId) => cancelPendingTurnAlarms(this, taskId),
		};
	}

	/** RPC: this chat's scheduled turns for the Settings Mini App (docs/adr/0028). */
	async listScheduledView(): Promise<ScheduledTurnView[]> {
		return this.scheduledTurns().list();
	}

	/** RPC: cancel a scheduled turn by id from the Settings Mini App. */
	async cancelScheduledTurn(id: string): Promise<boolean> {
		return this.scheduledTurns().cancel(id);
	}

	// ── Usage ledger: always-on token accounting (PRD #100) ──────────────────────

	/** Construct the chat's **Usage ledger** over the `usage_ledger` table. */
	private usageLedger(): UsageLedger {
		return new UsageLedger({ store: this.stores.usageLedger });
	}

	/** Best-effort accounting; failure must not fail the model call. */
	private recordUsage(userId: number, kind: UsageKind, model: string, usage: UsageLike): void {
		try {
			this.usageLedger().record({ userId, kind, model, usage });
		} catch (error) {
			console.warn({ message: 'Usage ledger write failed', error, kind, model });
		}
	}

	/** RPC: the `/usage` token section's data — today + trailing 7 days, by kind × model. */
	async usageReport(): Promise<UsageReport> {
		return this.usageLedger().report();
	}

	/** Attribute model calls made outside this DO, such as admin email triage. */
	async recordExternalUsage(userId: number, kind: UsageKind, model: string, usage: UsageLike): Promise<void> {
		this.recordUsage(userId, kind, model, usage);
	}

	// ── Tool approval: request → pending → approve/deny/expire (docs/adr/0039) ───

	/** Construct the chat's **Tool approvals** core over the `pending_approvals` table. */
	private toolApprovals(): ToolApprovals {
		return new ToolApprovals({ store: this.stores.approvals });
	}

	/** The core checks requester-or-admin. Queue approved execution or a denial note. */
	async decideApproval(
		id: string,
		verb: 'approve' | 'deny',
		deciderUserId: number,
		deciderIsAdmin: boolean,
		chatId: number,
		requestMessageId: number,
	): Promise<DecideResult['kind'] | 'expired'> {
		const result = this.toolApprovals().decide(id, verb, { userId: deciderUserId, isAdmin: deciderIsAdmin });
		if (result.kind === 'approved') {
			await this.queue(
				'runQueuedTurn',
				{
					kind: 'approval',
					toolName: result.approval.toolName,
					argsJson: result.approval.argsJson,
					chatId,
					replyToMessageId: requestMessageId,
					userId: result.approval.requestedBy,
				} satisfies QueuedTurn,
				{ retry: { maxAttempts: 1 } },
			);
		} else if (result.kind === 'denied') {
			await this.queue(
				'runQueuedTurn',
				{ kind: 'deny-note', toolName: result.approval.toolName, argsJson: result.approval.argsJson, chatId } satisfies QueuedTurn,
				{ retry: { maxAttempts: 1 } },
			);
		}
		return result.kind === 'stale' && result.reason === 'expired' ? 'expired' : result.kind;
	}

	/** Execute the stored snapshot with unwrapped tools, then let the model narrate the result. */
	private async runApprovedTool(payload: Extract<QueuedTurn, { kind: 'approval' }>): Promise<void> {
		const { toolName, argsJson, chatId, replyToMessageId, userId } = payload;
		const tools = buildBuiltinTools(this.env, {
			assets: { userId, chatId },
			memory: this.memory(chatId),
			sandbox: getSandbox(this.env.Sandbox, String(chatId)),
			sandboxUsage: this.sandboxUsage(userId),
		});
		const tool = tools[toolName];
		let resultJson: string;
		try {
			if (!tool?.execute) throw new Error(`Tool not available: ${toolName}`);
			const output = await tool.execute(JSON.parse(argsJson), { toolCallId: `approval-${Date.now()}`, messages: [], context: undefined });
			resultJson = JSON.stringify(output ?? null);
		} catch (error) {
			resultJson = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
		await this.runChatTurn(renderContinuationPrompt({ toolName, argsJson }, resultJson), chatId, replyToMessageId, userId);
	}

	/** Append the denial's Session note (docs/adr/0039: no inference; the model sees it next turn). Queued, so Session writes stay serial. */
	private async appendDenialNote(payload: Extract<QueuedTurn, { kind: 'deny-note' }>): Promise<void> {
		await this.chatSession.appendMessage(userMessage(renderDenialNote(payload)));
	}

	// ── Deep task: background fiber + delivery (docs/adr/0040) ───────────────────

	/** Construct the chat's **Deep tasks** core over the pinned `deep_task` row. */
	private deepTasks(): DeepTasks {
		return new DeepTasks({ store: this.stores.deepTasks });
	}

	/**
	 * The `deep_task` tool's launcher (docs/adr/0040): claim the single slot, send
	 * the `🔬 … [✖️ Cancel]` start message, and start the fiber fire-and-forget.
	 * A busy slot comes back as a soft `{ error }` for the model to relay.
	 */
	private deepTaskLauncher(chatId: number, userId: number): DeepTaskLauncher {
		return {
			launch: async ({ description, prompt }) => {
				const core = this.deepTasks();
				const started = core.start({ description, prompt, startedBy: userId });
				if ('error' in started) return started;

				const bot = new Bot(this.env);
				const view = renderDeepTaskProgress(started.task);
				const message = await bot
					.sendMessage({
						chat_id: chatId,
						text: view.text,
						disable_notification: true,
						reply_markup: { inline_keyboard: view.keyboard },
					})
					.catch((error) => {
						console.error({ message: 'Failed to send deep-task start message', error });
						return undefined;
					});
				if (message) core.attachStartMessage(message.message_id);

				void this.startFiber('deep-task', (ctx) => this.runDeepTaskFiber(ctx, chatId), {
					fiberId: started.task.id,
				}).catch((error) => console.error({ message: 'Deep-task fiber failed to start', error }));
				return { started: true };
			},
		};
	}

	/** Run with chat-local tools. Checkpoint partials for recovery; enqueue delivery to serialize history. */
	private async runDeepTaskFiber(ctx: { signal: AbortSignal; stash(data: unknown): void }, chatId: number): Promise<void> {
		const core = this.deepTasks();
		const task = core.snapshot();
		if (!task) return;

		const bot = new Bot(this.env);
		let body = '';
		let end: DeepTaskEnd = 'completed';
		let errorMessage: string | undefined;
		let phase: string | null = null;

		try {
			const remaining = Math.max(1000, task.startedAt + core.wallClockMs - Date.now());
			const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(remaining)]);
			const tools = buildBuiltinTools(this.env, {
				assets: { userId: task.startedBy, chatId },
				memory: this.memory(chatId),
					sandbox: getSandbox(this.env.Sandbox, String(chatId)),
				sandboxUsage: this.sandboxUsage(task.startedBy),
				feedUpdates: (since) => recentFeedEntries({ feeds: this.env.FEEDS, chatId, since, fetch: fetch.bind(globalThis) }),
				excludeRunShell: true,
			});

			const resolved = resolveModel(this.env);
			const { streamText } = await getAISDK();
			const result = streamText({
				model: resolved.model,
				system:
					'You are running a background deep task for a Telegram chat. Work through the task with your tools, ' +
					'then write the final report as your last message. The report is delivered verbatim — make it self-contained.',
				messages: [{ role: 'user', content: task.prompt }],
				tools,
				stopWhen: stepCountIs(core.maxSteps),
				maxOutputTokens: MAX_CHAT_TOKENS,
				abortSignal: signal,
				...aiTrace({
					functionId: 'conversation-agent.deep-task',
					conversationId: this.ctx.id.toString(),
					agentVersion: this.env.CF_VERSION_METADATA?.id,
					promptVersion: DEEP_TASK_PROMPT_VERSION,
				}),
				...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
			});

			for await (const chunk of result.fullStream) {
				if (chunk.type === 'text-delta') {
					body += chunk.text;
				} else if (chunk.type === 'text-end') {
					body += '\n\n';
				} else if (chunk.type === 'tool-call') {
					phase = chunk.toolName;
				} else if (chunk.type === 'finish-step') {
					const updated = core.recordStep(phase);
					ctx.stash({ body, stepsDone: updated?.stepsDone ?? 0 });
					if (updated?.startMessageId) {
						const view = renderDeepTaskProgress(updated, core.maxSteps);
						await bot.editMessageText(chatId, updated.startMessageId, view.text, { inline_keyboard: view.keyboard }).catch(() => {});
					}
					const gate = core.beginStep();
					if (!gate.allowed) {
						end = gate.reason === 'cancelled' ? 'cancelled' : gate.reason === 'timeout' ? 'timeout' : 'completed';
						break;
					}
				} else if (chunk.type === 'error') {
					throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
				}
			}
			// Ledger the fiber's usage (PRD #100), charged to the initiator. Only on a
			// clean stream end — an aborted run's usage promise may never settle, and
			// losing an aborted run's tokens is the accepted trade.
			this.recordUsage(task.startedBy, 'deep_task', DEFAULT_CHAT_MODEL, await result.usage);
		} catch (error) {
			const aborted = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
			if (aborted) {
				end = core.snapshot()?.status === 'cancelling' ? 'cancelled' : 'timeout';
			} else {
				end = 'error';
				errorMessage = error instanceof Error ? error.message : String(error);
			}
		}

		const current = core.snapshot();
		await this.queue(
			'runQueuedTurn',
			{
				kind: 'deep-delivery',
				chatId,
				taskId: task.id,
				description: task.description,
				prompt: task.prompt,
				startMessageId: current?.startMessageId ?? null,
				body,
				end,
				...(errorMessage ? { error: errorMessage } : {}),
			} satisfies QueuedTurn,
			{ retry: { maxAttempts: 1 } },
		);
	}

	/** Post the report and append it to Session without another model call, then release the slot. */
	private async deliverDeepTask(payload: Extract<QueuedTurn, { kind: 'deep-delivery' }>): Promise<void> {
		const delivery = composeDeepTaskDelivery(payload);
		const bot = new Bot(this.env);

		if (payload.startMessageId) {
			await bot
				.editMessageText(payload.chatId, payload.startMessageId, renderDeepTaskSettled(payload.description, payload.end), {
					inline_keyboard: [],
				})
				.catch(() => {});
		}

		let first = true;
		for (const text of delivery.messages) {
			await bot
				.sendMessage({
					chat_id: payload.chatId,
					text,
					...(first && payload.startMessageId ? { reply_parameters: { message_id: payload.startMessageId } } : {}),
				})
				.catch((error) => console.error({ message: 'Failed to deliver deep-task report', error }));
			first = false;
		}

		const session = this.chatSession;
		await session.appendMessage(userMessage(delivery.sessionUser));
		await session.appendMessage(assistantMessage(delivery.sessionAssistant));
		await this.compactHistory();
		this.deepTasks().finish();
	}

	/** Abort the fiber and mark cancellation; the completion path delivers partial results. */
	async cancelDeepTask(taskId: string): Promise<boolean> {
		const core = this.deepTasks();
		const task = core.snapshot();
		if (!task || task.id !== taskId) return false;
		core.requestCancel();
		await this.cancelFiber(taskId, 'user cancelled').catch(() => {});
		return true;
	}

	/** Deliver the last checkpoint as interrupted and release the slot after a DO restart. */
	override async onFiberRecovered(ctx: { id: string; name: string; snapshot: unknown }): Promise<void> {
		if (ctx.name !== 'deep-task') return;
		const task = this.deepTasks().snapshot();
		if (!task || task.id !== ctx.id) return;
		const body = ((ctx.snapshot as { body?: string } | null)?.body ?? '').toString();
		await this.queue(
			'runQueuedTurn',
			{
				kind: 'deep-delivery',
				chatId: Number(this.name),
				taskId: task.id,
				description: task.description,
				prompt: task.prompt,
				startMessageId: task.startMessageId,
				body,
				end: 'interrupted',
			} satisfies QueuedTurn,
			{ retry: { maxAttempts: 1 } },
		);
	}

	/** Save an email snapshot, then read it immediately without waiting for indexing. */
	async askEmail(
		emailId: number,
		chatId: number,
		replyToMessageId: number,
		userId: number,
	): Promise<void> {
		const principal = await resolvePrincipal(userId, chatId, this.env);
		if (!principal.can('manage_email')) throw new Error('Not authorized');
		const email = await emailRepository.getById(this.env, emailId);
		if (!email) throw new Error('Email unavailable');
		const body = await emailRepository.getBody(this.env, email.r2Key);
		const { asset } = await createAsset(this.env, principal, {
			origin: { type: 'email', emailId }, title: email.subject?.trim() || 'Email',
			text: body, urls: [], files: [], kind: 'text',
		});
		await this.enqueueChatTurn(`Read saved asset ${asset.id} with get_asset, summarize it, then answer follow-up questions.`, chatId, replyToMessageId, userId);
	}

	/** Wipe this chat's Long-term memories from Vectorize and the mirror (`/forget`). */
	async forget(chatId: number): Promise<number> {
		const { count } = await this.memory(chatId).forget();
		return count;
	}

	/** All Long-term memory facts, newest first — the Mini App Memory tab (docs/adr/0038). */
	async listMemories(chatId: number): Promise<StoredMemory[]> {
		return this.memory(chatId).list();
	}

	/** Read every Mini App chat setting in one RPC. */
	async settingsSnapshot(): Promise<{
		language: string | null;
		htmlParser: 'turndown' | 'ai';
		debug: boolean;
		reasoning: ReasoningEffort;
		compactionThreshold: number;
		memoryTopK: number;
	}> {
		return {
			language: this.settings.language,
			htmlParser: this.settings.htmlParser,
			debug: this.settings.debug,
			reasoning: this.settings.reasoning,
			compactionThreshold: this.settings.compactionThreshold,
			memoryTopK: this.settings.memoryTopK,
		};
	}

	/** Apply a route-validated Mini App settings patch and return the resulting snapshot. */
	async updateSettings(patch: {
		language?: string | null;
		htmlParser?: 'turndown' | 'ai';
		debug?: boolean;
		reasoning?: ReasoningEffort;
		compactionThreshold?: number | null;
		memoryTopK?: number | null;
	}): ReturnType<ConversationAgent['settingsSnapshot']> {
		if (patch.language !== undefined) this.settings.language = patch.language;
		if (patch.htmlParser !== undefined) this.settings.htmlParser = patch.htmlParser;
		if (patch.debug !== undefined) this.settings.debug = patch.debug;
		if (patch.reasoning !== undefined) this.settings.reasoning = patch.reasoning;
		if (patch.compactionThreshold !== undefined) this.settings.compactionThreshold = patch.compactionThreshold;
		if (patch.memoryTopK !== undefined) this.settings.memoryTopK = patch.memoryTopK;
		return this.settingsSnapshot();
	}

	async clear(): Promise<void> {
		await this.chatSession.clearMessages();
		this.stores.emailReply.clear();
		this.toolApprovals().voidAll();
	}

	// ── Email tool: refer → draft → confirm → send (ADR-0009 and ADR-0013, unpublished) ─────────
	//
	// The state machine lives in the EmailReply module; the DO constructs it with
	// injected deps, relays RPC, and owns the pinned `email_reply` SQL row.

	private emailReply(): EmailReply {
		const model = resolveModel(this.env).model;
		// Ledger truthfulness (ADR-0041): the id off the resolved model, never a
		// constant that could silently desynchronize from it.
		const modelId = typeof model === 'string' ? model : model.modelId;
		return new EmailReply({
			model,
			originalBody: (r2Key) => emailRepository.getBody(this.env, r2Key),
			email: this.env.EMAIL,
			// Attribution: the DM chat id — the reply flow is admin-DM-only, matching
			// the "unattended calls charge the chat id" ledger rule.
			onUsage: (usage) => this.recordUsage(Number(this.name), 'email_reply', modelId, usage),
		});
	}

	/** Replace the pending email reply and prompt for the admin’s gist. */
	async armEmailReply(input: ArmReplyInput, chatId: number): Promise<void> {
		const { change, prompt } = this.emailReply().arm(input);
		this.applyReplyChange(change);

		// Plain text (no parse_mode): the subject/snippet are arbitrary email content
		// and would routinely break Markdown parsing (→ silent 400 drop).
		const bot = new Bot(this.env);
		await bot
			.sendMessage({ chat_id: chatId, text: prompt })
			.catch((error) => console.error({ message: 'Failed to send reply-arm prompt', error }));
	}

	/** Deliver a draft confirmation or a plain model-failure notice. */
	private async draftReply(state: ReplyState, instruction: string, bot: Bot, chatId: number): Promise<void> {
		bot.sendChatAction(chatId, 'typing').catch(() => {});

		const { change, message } = await this.emailReply().draft(state, instruction);
		this.applyReplyChange(change);

		await bot
			.sendMessage({
				chat_id: chatId,
				// The plain `sendMessage` path keeps the real 4096 limit (ADR-0013, unpublished).
				text: message.text.slice(0, SEND_MESSAGE_TEXT_LIMIT),
				...(message.buttons ? { reply_markup: { inline_keyboard: message.buttons } } : {}),
			})
			.catch((error) => console.error({ message: 'Failed to send draft message', error }));
	}

	/** Send the drafted reply via the EMAIL binding. RPC, invoked on `✅ Send`. */
	async sendArmedReply(_chatId: number): Promise<ReplyActionResult> {
		const { change, result } = await this.emailReply().send(this.stores.emailReply.get());
		this.applyReplyChange(change);
		return result;
	}

	/** Re-open the armed reply for a new gist. RPC, invoked on `✏️ Edit`. */
	async editArmedReply(_chatId: number): Promise<ReplyActionResult> {
		const { change, result } = this.emailReply().edit(this.stores.emailReply.get());
		this.applyReplyChange(change);
		return result;
	}

	/** Discard the armed reply. RPC, invoked on `✖️ Cancel`. */
	async cancelArmedReply(_chatId: number): Promise<ReplyActionResult> {
		const { change, result } = this.emailReply().cancel(this.stores.emailReply.get());
		this.applyReplyChange(change);
		return result;
	}

	/** Apply the module's decided state transition to the pinned SQL row. */
	private applyReplyChange(change: ReplyStateChange): void {
		if (change.kind === 'store') {
			this.stores.emailReply.save(change.state);
		} else if (change.kind === 'clear') this.stores.emailReply.clear();
	}
}
