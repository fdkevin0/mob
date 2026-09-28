import { stepCountIs, streamText as baseStreamText, type ModelMessage, type ToolSet } from 'ai';
import type { Agent } from 'agents';
import { Env } from '../../core/env';
import { DEFAULT_CHAT_MODEL, MAX_CHAT_TOKENS, resolveModel } from './model';
import type { ReasoningEffort } from './reasoning-effort';
import { mcpRegistry, type McpServerRow } from '../mcp/registry';
import type { DebugToolCall, DebugTrace } from '../agent/debug-trace';
import { stringifyToolError } from '../agent/transcript';
import { dispatchChunk, type AgenticSink } from './agentic-sink';
import { aiTrace, getAISDK } from './sdk';

/** Max tool-calling iterations per turn (see docs/adr/0008). */
const MAX_STEPS = 5;

/**
 * The identity system prompt for the **agentic chat turn** (docs/adr/0008). Supplied
 * to the **Session**'s `identity` context (docs/adr/0017), frozen into the cached
 * system prompt, and passed to `streamText`'s `system` option — never as a message
 * inside the window (the AI SDK flags an in-`messages` system role as a
 * prompt-injection risk). The email path uses its own prompts (ADR-0041); the two
 * **AI framework** paths stay split.
 */
export const SYSTEM_PROMPT = 'You are a concise Telegram chatbot. Reply in the same language as the user unless asked otherwise.';

/** Bump whenever the agentic chat system-prompt contract changes. */
export const SYSTEM_PROMPT_VERSION = 'chat-2026-09-02.1';

// Model construction moved to `model.ts` (docs/adr/0041): one provider site for
// every call path, importable by Node-run test modules without the `agents` dep.
/**
 * The minimal MCP-bearing subset of `Agent<Env>` that `reconcileMcpTools` /
 * `runAgenticTurn` actually touch (docs/adr/0047) — a structural
 * `Pick`, not a hand-written interface, so it can never drift out of sync with
 * the real `Agent<Env>` shape. Narrower than the full Agent so callers (the
 * turn driver, its tests) need no fake-Agent cast.
 */
export type McpBearingAgent = Pick<Agent<Env>, 'mcp' | 'addMcpServer' | 'removeMcpServer'>;

/** Load MCP normalization only for a nonempty registry, keeping the empty path usable in Node tests. */
async function wantedMcpServers(enabled: McpServerRow[]): Promise<Map<string, McpServerRow>> {
	if (enabled.length === 0) return new Map();
	const { normalizeServerId } = await import('agents/mcp/client');
	return new Map(enabled.map((s) => [normalizeServerId(s.name), s]));
}

/**
 * Reconcile an Agent's live MCP connections (`agent.mcp`) against the global
 * registry (docs/adr/0008): connect enabled servers that aren't connected,
 * disconnect ones that were removed or disabled. A server that fails to connect
 * is skipped with a logged warning — never failing the turn. Returns the
 * AI-SDK `ToolSet` aggregated from the connected servers.
 */
export async function reconcileMcpTools(agent: McpBearingAgent, env: Env): Promise<ToolSet> {
	const enabled = await mcpRegistry.listEnabled(env);
	const wanted = await wantedMcpServers(enabled);
	const connections = agent.mcp.mcpConnections;

	// Disconnect servers no longer wanted, or whose URL changed in the registry
	// (an in-place `/mcp add <name> <new-url>`): a stale connection would keep
	// talking to the old endpoint until the DO restarts, so drop it and let the
	// connect pass below re-add it with the new URL + auth. A bearer-token-only
	// rotation (same URL) is picked up by toggling the server off then on.
	for (const id of Object.keys(connections)) {
		const want = wanted.get(id);
		const urlChanged = want ? connections[id]?.url?.toString() !== want.url : false;
		if (!want || urlChanged) {
			await agent.removeMcpServer(id).catch((e) => console.warn({ message: 'MCP remove failed', feature: 'mcp', serverId: id, error: e }));
			if (urlChanged) delete connections[id]; // re-add below
		}
	}

	// Connect newly-wanted (or just-dropped) servers (bearer token via header).
	for (const [id, server] of wanted) {
		if (connections[id]) continue;
		const headers = server.authType === 'bearer' && server.authToken ? { Authorization: `Bearer ${server.authToken}` } : undefined;
		try {
			await agent.addMcpServer(server.name, server.url, {
				id: server.name,
				...(headers ? { transport: { headers } } : {}),
			});
		} catch (e) {
			console.warn({ message: 'MCP connect failed', feature: 'mcp', serverName: server.name, error: e });
		}
	}

	return agent.mcp.getAITools();
}

/** The composed prompt for a turn: the system prompt and the message window. */
export interface AgenticPrompt {
	/** The system prompt — from `session.freezeSystemPrompt()` (docs/adr/0017). */
	system: string;
	/** The history window + new user turn, already mapped to `ModelMessage[]`. */
	messages: ModelMessage[];
	/** The chat's own **Chat settings** reasoning effort (docs/adr/0036) — `'default'` (the model's own default) if unset. */
	reasoningEffort?: ReasoningEffort;
	/** Opaque Conversation Agent Durable Object id for native trace correlation. */
	conversationId: string;
}

/** Stream model events to the sink in order; the caller composes history and built-in tools. */
export async function runAgenticTurn(
	agent: McpBearingAgent,
	env: Env,
	prompt: AgenticPrompt,
	sink: AgenticSink,
	extraTools: ToolSet = {},
	/**
	 * When provided (Debug mode on, docs/adr/0011), this turn's process parameters
	 * and tool calls are recorded into it for the Debug trace. Purely
	 * observational — capturing it does not change the turn.
	 */
	trace?: DebugTrace,
	/**
	 * Always-on usage hook (PRD #100): called with the turn's token usage after a
	 * successful stream. Best-effort — the caller records it into the **Usage
	 * ledger**; a throwing hook must not fail the turn, so errors are swallowed.
	 */
	onUsage?: (usage: Awaited<ReturnType<typeof baseStreamText>['usage']>) => void,
): Promise<void> {
	const mcpTools = await reconcileMcpTools(agent, env);
	const tools: ToolSet = { ...mcpTools, ...extraTools };
	const { system, messages, reasoningEffort } = prompt;

	if (trace) {
		trace.process = {
			model: DEFAULT_CHAT_MODEL,
			promptVersion: SYSTEM_PROMPT_VERSION,
			system,
			// Keep diagnostics useful without copying image payloads into JSON traces.
			messages: messages.map((message) => message.role === 'user' && Array.isArray(message.content)
				? { ...message, content: message.content.map((part) => part.type === 'file' ? { ...part, data: '[omitted from debug trace]' } : part) }
				: message),
			tools: Object.keys(tools),
			maxSteps: MAX_STEPS,
			maxOutputTokens: MAX_CHAT_TOKENS,
		};
	}

	const resolved = resolveModel(env, reasoningEffort);
	const { streamText } = await getAISDK();
	const result = streamText({
		model: resolved.model,
		system,
		messages,
		tools,
		stopWhen: stepCountIs(MAX_STEPS),
		maxOutputTokens: MAX_CHAT_TOKENS,
		...aiTrace({
			functionId: 'conversation-agent.chat',
			conversationId: prompt.conversationId,
			agentVersion: env.CF_VERSION_METADATA?.id,
			promptVersion: SYSTEM_PROMPT_VERSION,
		}),
		...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
	});

	// `fullStream` surfaces a mid-stream failure as an `error` chunk (it does not
	// throw the way `textStream` does), so capture it and rethrow after the loop —
	// the orchestrator's catch persists the partial transcript with an interruption
	// marker (docs/adr/0021).
	let streamError: unknown;
	for await (const chunk of result.fullStream) {
		if (chunk.type === 'error') {
			streamError = chunk.error;
			break;
		}
		await dispatchChunk(chunk, sink);
	}

	if (streamError !== undefined) {
		throw streamError instanceof Error ? streamError : new Error(String(streamError));
	}

	if (onUsage) {
		try {
			onUsage(await result.usage);
		} catch (error) {
			console.warn({ message: 'Usage hook failed', error });
		}
	}

	if (trace) {
		trace.toolCalls = await collectToolCalls(result);
		trace.usage = await result.usage;
		trace.finishReason = await result.finishReason;
	}
}

/** Flatten the stream's per-step tool calls + results into the Debug trace shape. */
async function collectToolCalls(result: ReturnType<typeof baseStreamText>): Promise<DebugToolCall[]> {
	const steps = await result.steps;
	const calls: DebugToolCall[] = [];
	for (const step of steps) {
		const outputs = new Map(step.toolResults.map((r) => [r.toolCallId, r.output]));
		// A tool that throws surfaces as a `tool-error` content part, not a
		// `toolResults` entry — capture it so the trace distinguishes a failed call
		// from one that legitimately returned `undefined` (docs/adr/0011).
		const errors = new Map(
			step.content
				.filter((part): part is Extract<typeof part, { type: 'tool-error' }> => part.type === 'tool-error')
				.map((part) => [part.toolCallId, part.error]),
		);
		for (const call of step.toolCalls) {
			const base = { name: call.toolName, arguments: call.input };
			calls.push(
				errors.has(call.toolCallId)
					? { ...base, error: stringifyToolError(errors.get(call.toolCallId)) }
					: { ...base, result: outputs.get(call.toolCallId) },
			);
		}
	}
	return calls;
}
