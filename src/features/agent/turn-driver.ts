/** Orchestration for every Telegram conversational turn. */
import type { FileUIPart, TextUIPart } from 'ai';
import { DEFAULT_CHAT_MODEL } from '../ai/model';
import type { Session } from 'agents/sessions';
import type { ContextBlocks } from 'agents/context';
import type { Env } from '../../core/env';
import type { Principal } from '../../core/principal';
import { Bot } from '../../core/bot';
import { runAgenticTurn, type McpBearingAgent } from '../ai/agentic';
import { historyToModelMessages, userMessage, assistantMessage } from '../ai/session-messages';
import type { ReasoningEffort } from '../ai/reasoning-effort';
import { emailRepository, toEmailSummary } from '../email/repository';
import { TelegramReplySurface, makeTelegramEmit } from './reply-surface';
import { runTurnCore } from './turn-events';
import type { DebugTrace } from './debug-trace';
import { buildBuiltinTools, builtinToolSummaries, builtinToolLabels, type BuiltinToolDeps } from './tools';
import { formatRecallPreamble, type Memory } from '../memory/memory';
import type { SandboxRunner } from './tools/sandbox';
import type { SandboxUsage } from './sandbox-usage';
import type { ScheduledTurns } from './scheduled-turns';
import { renderApprovalRequest, type ToolApprovals } from './tool-approvals';
import type { ApprovalGate } from './tools/approval';
import type { DeepTaskLauncher } from './tools/deep-task';
import type { UsageKind, UsageLike } from './usage-ledger';
import type { ChatSettings } from './chat-settings';
import { recentFeedEntries } from '../feed/recent';
import { readTelegramAttachment, type TelegramAttachment } from './telegram-attachment';

/** Capabilities injected by the Durable Object; keeps this driver testable. */
export interface TurnDriverDeps {
	env: Env;
	agent: McpBearingAgent;
	/** Opaque Durable Object id used only for privacy-safe native trace correlation. */
	traceConversationId: string;
	settings: ChatSettings;
	session: Session;
	compactHistory: () => Promise<void>;
	context: ContextBlocks;
	memory: (chatId: number) => Memory;
	/** This chat's Sandbox stub for the given id (docs/adr/0019) — see the module doc for why this is a factory, not a direct `getSandbox` call. */
	sandbox: (id: string) => SandboxRunner;
	sandboxUsage: (userId: number) => SandboxUsage;
	toolApprovals: () => ToolApprovals;
	scheduledTurns: () => ScheduledTurns;
	deepTaskLauncher: (chatId: number, userId: number) => DeepTaskLauncher;
	bot: Bot;
	/** The turn's initiating Principal (docs/adr/0031), injected so driver tests need no D1. */
	resolvePrincipal: (senderId: number, chatId: number) => Promise<Principal>;
	recordUsage: (userId: number, kind: UsageKind, model: string, usage: UsageLike) => void;
}

export interface TurnDriverInput {
	text: string;
	attachment?: TelegramAttachment;
	chatId: number;
	replyToMessageId: number;
	userId: number;
	onError?: (error: unknown) => void;
}

/** Run, deliver, and persist one Telegram turn. */
export async function runTurn(deps: TurnDriverDeps, input: TurnDriverInput): Promise<void> {
	const { chatId, replyToMessageId, userId, onError } = input;
	const text = input.text;
	let attachmentPart: FileUIPart | TextUIPart | undefined;
	const { env, agent, settings, bot } = deps;
	// Re-check access when queued work starts, before downloading any attachment.
	const principal = await deps.resolvePrincipal(userId, chatId);
	if (input.attachment) {
		if (!principal.can('use_chat')) return;
		await bot.sendChatAction(chatId, 'typing').catch(() => {});
		const result = await readTelegramAttachment(bot, env.AI, input.attachment);
		if ('error' in result) {
			await bot.sendMessage({ chat_id: chatId, reply_parameters: { message_id: replyToMessageId }, text: result.error });
			return;
		}
		attachmentPart = result.part;
	}

	const reasoningEffort: ReasoningEffort = settings.reasoning;
	const { session, context } = deps;

	// Debug mode (docs/adr/0011): when on, hand `runAgenticTurn` a trace to fill;
	// the surface uploads it as a JSON file after finalize — even if the turn
	// errored, so failures are debuggable. Off → undefined, zero overhead.
	const trace: DebugTrace | undefined = settings.debug ? { toolCalls: [] } : undefined;

	const emit = makeTelegramEmit(new TelegramReplySurface(bot, { chatId, messageId: replyToMessageId }));

	// The Tool approval gate (docs/adr/0039): `run_shell` files a pending
	// snapshot + sends the Approve/Deny message instead of executing.
	const approvalGate: ApprovalGate = {
		request: async (toolName: string, args: unknown) => {
			const row = deps.toolApprovals().request(toolName, args, userId);
			const view = renderApprovalRequest(row);
			await bot
				.sendMessage({
					chat_id: chatId,
					text: view.text,
					reply_markup: { inline_keyboard: view.keyboard },
				})
				.catch((error) => console.error({ message: 'Failed to send approval request', error }));
			return { id: row.id };
		},
	};

	// Built-in agent tools (docs/adr/0015) plus the Session's context tools
	// (`set_context` writes the scratchpad memory block, docs/adr/0017) enter the
	// turn through the existing `extraTools` seam.
	const toolDeps: BuiltinToolDeps = {
		...(principal.can('use_chat') ? { assets: { userId, chatId } } : {}),
		sandbox: deps.sandbox(String(chatId)),
		fetchParser: settings.htmlParser,
		sandboxUsage: deps.sandboxUsage(userId),
		memory: deps.memory(chatId),
		feedUpdates: (since) => recentFeedEntries({ feeds: env.FEEDS, chatId, since, fetch: fetch.bind(globalThis) }),
		approvalGate,
		...(principal.can('schedule_turns') ? { scheduledTurns: deps.scheduledTurns() } : {}),
		...(principal.can('schedule_turns') ? { deepTask: deps.deepTaskLauncher(chatId, userId) } : {}),
		...(principal.can('manage_email')
			? {
					recentEmails: (limit: number) => emailRepository.listRecent(env, limit).then((rows) => rows.map(toEmailSummary)),
			  }
			: {}),
	};
	const builtinTools = buildBuiltinTools(env, toolDeps);
	const tools = { ...builtinTools, ...(await context.tools()) };

	// Compose the prompt from the Session: the cached system prompt (identity +
	// scratchpad), and the stored history (compaction overlays applied) plus the
	// new user turn, mapped to ModelMessages. The user message is appended to the
	// Session only on a successful reply, so a failed turn leaves no orphan.
	// The cached identity+scratchpad prompt, then — outside the freeze — the chat's
	// Language preference (docs/adr/0025) so it is current every turn (no staleness if
	// `/language` runs mid-conversation) while the cached prefix still hits the prompt
	// cache. Unset → nothing appended; the identity's natural-mirror default stands.
	const language = settings.language;
	const baseSystem = await context.freezeSystemPrompt();
	let system = language ? `${baseSystem}\n\nReply in this language: ${language}` : baseSystem;

	// Auto-recall (docs/adr/0038): one embedding + one Vectorize query per turn
	// (skipped for trivially short messages), injected as a preamble on the
	// turn's user message — the volatile prompt tail, so the cacheable
	// system+history prefix stays byte-stable. The *persisted* user message
	// stays raw: retrieved facts never enter history, so compaction can't mine
	// them back into memory. Best-effort — a recall failure never fails the turn.
	const recalled = await deps
		.memory(chatId)
		.autoRecall(input.text)
		.catch((error) => {
			console.warn({ message: 'Auto-recall failed', error });
			return [];
		});
	if (trace) trace.recalledMemories = recalled.map((hit) => ({ text: hit.text, score: hit.score }));
	const turnText = recalled.length > 0 ? `${formatRecallPreamble(recalled)}\n\n${text}` : text;

	const userMsg = userMessage(text);
	if (attachmentPart) userMsg.parts.push(attachmentPart);
	// Leave room for the new 10 MiB image's base64 and the serialized API request.
	const history = await session.getRecentHistory(16 * 1024 * 1024);
	if (history.truncated) system += '\nOlder history was omitted to fit the request. Ask the user to resend an image if it is no longer present.';
	const promptMsg = { ...userMsg, parts: [{ type: 'text', text: turnText }, ...userMsg.parts.slice(1)] };
	const messages = await historyToModelMessages([...history.messages, promptMsg]);

	await runTurnCore({
			trace,
			// The Tool message summary hooks for the built-in tools (docs/adr/0021);
			// MCP and session tools have none and render status-only.
			summaries: builtinToolSummaries,
			// The live input-label hooks (docs/adr/0026): query / domain / language shown
			// the moment a built-in tool is called. MCP and session tools have none.
			labels: builtinToolLabels,
			emit,
			// The Usage ledger hook (PRD #100): always-on, attributed to the turn's
			// initiating Principal (a scheduled firing passes chatId — the existing rule).
			runTurn: (sink, t) =>
				runAgenticTurn(
					agent,
					env,
					{ system, messages, reasoningEffort, conversationId: deps.traceConversationId },
					sink,
					tools,
					t,
					(usage) => deps.recordUsage(userId, 'chat', DEFAULT_CHAT_MODEL, usage),
				),
			// Persist the flattened **Transcript** as the assistant turn (docs/adr/0021):
			// prose interleaved with `> 🔧 …` tool blockquotes, so the model recalls its
			// own prior tool usage. Only when the turn produced something to remember.
			onReply: async (transcript) => {
				await session.appendMessage(userMsg);
				await session.appendMessage(assistantMessage(transcript));
				await deps.compactHistory();
			},
			onError,
			// A caller that observes failure (only a **Scheduled turn** firing today)
			// sends its own tailored `⚠️` line; the generic fallback notice would
			// otherwise double-ping the chat on every failed firing (docs/adr/0028).
			suppressErrorNotice: Boolean(onError),
	});
}
