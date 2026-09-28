import { assetTools, type AssetReader } from '../../assets/tools';
import type { ToolSet } from 'ai';
import type { Env } from '../../../core/env';
import type { Memory } from '../../memory/memory';
import { datetimeTool } from './datetime';
import { fetchUrlTool } from './fetch-url';
import { rememberTool, recallTool } from './memory-tools';
import { runCodeTool } from './run-code';
import { runShellTool } from './run-shell';
import { webSearchTool } from './web-search';
import { weatherTool } from './weather';
import { scheduleTurnTool, listScheduledTool, cancelScheduledTool } from './schedule-tools';
import { listFeedUpdatesTool, listRecentEmailsTool, type FeedUpdatesDeps, type RecentEmailsDeps } from './read-tools';
import { withApproval, type ApprovalGate } from './approval';
import { deepTaskTool, type DeepTaskLauncher } from './deep-task';
import type { SandboxRunner } from './sandbox';
import type { SandboxUsageGate } from '../sandbox-usage';
import type { ScheduledTurns } from '../scheduled-turns';

export interface BuiltinToolDeps {
	assets?: AssetReader;
	/** The chat's Long-term Memory module. Omitted when no collision-free scope exists. */
	memory?: Memory;
	/** The chat's Sandbox stub for the `run_code` / `run_shell` tools (docs/adr/0019). */
	sandbox: SandboxRunner;
	/** Per-user budget within this chat, shared by code and shell; always supplied in production. */
	sandboxUsage?: SandboxUsageGate;
	/** Clock for the Datetime tool. Defaults to `new Date()`. */
	now?: () => Date;
	/** Fetch impl for the Markdown fetch tool. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Supplied when the Principal has schedule_turns; absent inside deep-task fibers. */
	scheduledTurns?: ScheduledTurns;
	/** The chat's feed reader for `list_feed_updates` (docs/adr/0028). Registered when present. */
	feedUpdates?: FeedUpdatesDeps['recent'];
	/** Admin inbox reader; supplied only when the Principal can manage_email. */
	recentEmails?: RecentEmailsDeps['recent'];
	/** Wraps run_shell with approval. Omitted for approved-snapshot execution and tests. */
	approvalGate?: ApprovalGate;
	/** Supplied for schedule_turns holders; absent inside fibers to prevent recursive tasks. */
	deepTask?: DeepTaskLauncher;
	/** Exclude shell in fibers, where approval continuations cannot run. */
	excludeRunShell?: boolean;

		/**
		 * HTML→Markdown parser for `fetch_url` (Chat settings).
		 * `'turndown'` (default), `'ai'` for Workers AI `toMarkdown`.
		 */
		fetchParser?: 'turndown' | 'ai';
}

/** Assemble built-ins from the caller’s authorized dependencies and configured integrations. */
export function buildBuiltinTools(env: Env, deps: BuiltinToolDeps): ToolSet {
	const now = deps.now ?? (() => new Date());
	// Bind the global `fetch` to `globalThis`: the fetch tool calls it as
	// `deps.fetch(...)` (a method call), which would otherwise rebind `this` to the
	// deps object and trip the Workers runtime's "Illegal invocation" guard
	// (https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors).
	const fetchImpl = deps.fetch ?? fetch.bind(globalThis);

	return {
		...assetTools(env, deps.assets),
		get_date_time: datetimeTool({ now, defaultTimezone: env.BOT_TIMEZONE ?? 'UTC' }),
		fetch_url: fetchUrlTool({ fetch: fetchImpl, ai: env.AI, parser: deps.fetchParser }),
		...(deps.memory
			? {
					remember: rememberTool(deps.memory),
					recall: recallTool(deps.memory),
				}
			: {}),
		run_code: runCodeTool(deps.sandbox, { usage: deps.sandboxUsage }),
		// `run_shell` sits behind the Tool approval gate when one is passed
		// (docs/adr/0039) and is absent from the Deep-task fiber's set (docs/adr/0040).
		...(deps.excludeRunShell
			? {}
			: {
					run_shell: deps.approvalGate
						? withApproval('run_shell', runShellTool(deps.sandbox, { usage: deps.sandboxUsage }), deps.approvalGate)
						: runShellTool(deps.sandbox, { usage: deps.sandboxUsage }),
				}),
		get_weather: weatherTool({ fetch: fetchImpl }),
		// `web_search` is gated on the Tavily key (docs/adr/0022): spread it in only
		// when configured so the model never sees a tool it cannot use.
		...(env.TAVILY_API_KEY
			? { web_search: webSearchTool({ fetch: fetchImpl, apiKey: env.TAVILY_API_KEY }) }
			: {}),
		...(deps.scheduledTurns
			? {
					schedule_turn: scheduleTurnTool(deps.scheduledTurns),
					list_scheduled: listScheduledTool(deps.scheduledTurns),
					cancel_scheduled: cancelScheduledTool(deps.scheduledTurns),
				}
			: {}),
		// The read-only briefing tools (docs/adr/0028), each gated on its reader dep:
		// feeds are chat-scoped (always passed in prod); the inbox is the admin's.
		...(deps.feedUpdates ? { list_feed_updates: listFeedUpdatesTool({ recent: deps.feedUpdates, now }) } : {}),
		...(deps.recentEmails ? { list_recent_emails: listRecentEmailsTool({ recent: deps.recentEmails }) } : {}),
		// The Deep-task launcher (docs/adr/0040), gated on the dep like the
		// Scheduled-turn trio: passed for `schedule_turns` holders only.
		...(deps.deepTask ? { deep_task: deepTaskTool(deps.deepTask) } : {}),
	};
}

/** Bounded tool-result summaries for display and history. Raw payloads belong in debug traces. */
export const builtinToolSummaries: Record<string, (output: unknown) => string> = {
	get_date_time: (output) => asRecord(output).readable as string,
	remember: (output) => (asRecord(output).saved ? 'saved' : ''),
	recall: (output) => {
		const memories = asRecord(output).memories;
		return Array.isArray(memories) ? `${memories.length} ${memories.length === 1 ? 'note' : 'notes'}` : '';
	},
	fetch_url: (output) => {
		const markdown = asRecord(output).markdown;
		return typeof markdown === 'string' ? `${markdown.length} chars` : '';
	},
	web_search: (output) => {
		const results = asRecord(output).results;
		return Array.isArray(results) ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : '';
	},
	get_weather: (output) => {
		const o = asRecord(output);
		if (typeof o.error === 'string') return o.error;
		const current = asRecord(o.current);
		const temp = current.temperature;
		const condition = current.condition;
		return typeof temp === 'number' ? `${o.location} · ${Math.round(temp)}°C ${condition ?? ''}`.trim() : '';
	},
	schedule_turn: (output) => {
		const o = asRecord(output);
		if (typeof o.error === 'string') return o.error;
		return typeof o.next === 'string' ? `next ${o.next}` : '';
	},
	list_scheduled: (output) => {
		const tasks = asRecord(output).tasks;
		return Array.isArray(tasks) ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}` : '';
	},
	cancel_scheduled: (output) => {
		const o = asRecord(output);
		if (typeof o.error === 'string') return o.error;
		return o.cancelled ? 'cancelled' : '';
	},
	list_feed_updates: (output) => {
		const o = asRecord(output);
		const entries = Array.isArray(o.entries) ? o.entries.length : 0;
		const failed = Array.isArray(o.failed) ? o.failed.length : 0;
		const base = `${entries} ${entries === 1 ? 'entry' : 'entries'}`;
		return failed > 0 ? `${base} · ${failed} ${failed === 1 ? 'feed' : 'feeds'} failed` : base;
	},
	list_recent_emails: (output) => {
		const emails = asRecord(output).emails;
		return Array.isArray(emails) ? `${emails.length} ${emails.length === 1 ? 'email' : 'emails'}` : '';
	},
	run_shell: (output) => (asRecord(output).pendingApproval ? 'awaiting approval' : ''),
	deep_task: (output) => {
		const o = asRecord(output);
		if (typeof o.error === 'string') return o.error;
		return o.started ? 'started' : '';
	},
};

/** Short input labels shown at tool start and retained in history; URL labels expose only the hostname. */
export const builtinToolLabels: Record<string, (input: unknown) => string> = {
	web_search: (input) => {
		const query = asRecord(input).query;
		return typeof query === 'string' ? query : '';
	},
	fetch_url: (input) => {
		const url = asRecord(input).url;
		if (typeof url !== 'string') return '';
		try {
			return new URL(url).hostname;
		} catch {
			return '';
		}
	},
	run_code: (input) => {
		const language = asRecord(input).language;
		return typeof language === 'string' ? language : '';
	},
	schedule_turn: (input) => {
		const description = asRecord(input).description;
		return typeof description === 'string' ? description : '';
	},
	cancel_scheduled: (input) => {
		const id = asRecord(input).id;
		return typeof id === 'string' ? id : '';
	},
	deep_task: (input) => {
		const description = asRecord(input).description;
		return typeof description === 'string' ? description : '';
	},
};

/** Narrow an unknown tool result/input to a readable record; `{}` if it is not one. */
function asRecord(output: unknown): Record<string, unknown> {
	return output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
}
