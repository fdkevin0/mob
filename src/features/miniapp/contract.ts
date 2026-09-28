/**
 * Types-only contract between the Worker (`route.ts`, producing) and the
 * Settings Mini App SPA (`webapp/`, consuming) for the domain payloads shared
 * across `/miniapp/settings/*` endpoints (docs/adr/0036). Endpoint-only response
 * wrappers stay beside the browser API calls. No runtime, no DOM, no
 * Worker imports beyond `import type` — it must type-check cleanly under both
 * the root Worker `tsconfig` (commonjs, no DOM lib) and `webapp/tsconfig.json`
 * (ESM, DOM lib), and erase entirely at build. A renamed field here breaks the
 * build instead of production.
 */
import type { EmailPreviewData } from '../email/preview';
import type { ReasoningEffort as AiReasoningEffort } from '../ai/reasoning-effort';
import type { HtmlParserKind } from '../ai/types';

export type { EmailPreviewData };

/**
 * The four gated capabilities the shell reports back so the client can gate
 * tabs/buttons (mirrors `Capability` in `../../core/principal`, duplicated
 * rather than imported: `principal.ts` pulls in D1/drizzle/`Env`, which don't
 * type-check under `webapp/tsconfig.json`'s DOM-only, no-`workers-types`
 * setup — keeping this contract self-contained is the point).
 */
export type Capability = 'use_chat' | 'use_commands' | 'schedule_turns' | 'manage_mcp' | 'manage_email' | 'view_debug' | 'view_errors' | 'manage_users' | 'admin_ops';

export const ALL_CAPABILITIES = ['view_debug', 'schedule_turns', 'manage_email', 'admin_ops'] as const satisfies readonly Capability[];

/**
 * The wire shape of a scheduled turn (mirrors `ScheduledTurnView` in
 * `../agent/scheduled-turns`, not imported for the same reason as
 * `Capability` above): `next` is a `Date | null` server-side, an ISO string
 * (or `null`) once `JSON.stringify`d.
 */
export interface ScheduledTurnPayload {
	id: string;
	description: string;
	prompt: string;
	when: { kind: 'once'; at: number } | { kind: 'recurring'; cron: string; timezone: string };
	status: 'active' | 'failed';
	lastError: string | null;
	createdAt: number;
	next: string | null;
}

export interface BootstrapResponse {
	capabilities: Capability[];
	language: string | null;
	/** Only present when the Principal holds `view_debug` (server never emits it otherwise). */
	debug?: boolean;
	/** Only present when the Principal holds `schedule_turns`. */
	schedules?: ScheduledTurnPayload[];
}

export type ReasoningEffort = AiReasoningEffort;

export interface GlobalServiceDataResponse {
	/** The email triage HTML→Markdown converter (ADR-0045, unpublished). */
	emailHtmlParser: HtmlParserKind;
}

export interface ChatSettingsDataResponse {
	reasoningEffort: ReasoningEffort;
	compactionThreshold: number;
	memoryTopK: number;
}

/**
 * An email list row (mirrors `EmailSummary` in `../email/repository`, not
 * imported for the same reason as `Capability`/`ScheduledTurnPayload` above:
 * `repository.ts` pulls in drizzle/`Env`).
 */
export interface EmailSummary {
	id: number;
	from: string;
	subject: string | null;
	date: string | null;
	snippet: string | null;
	/** True → the Email tab shows a SPAM badge (inbound auth failed our bar). */
	spam: boolean;
}

/**
 * A long-term memory fact (docs/adr/0038) for the Memory tab (mirrors
 * `StoredMemory` in `../memory/memory`, duplicated for the same
 * tsconfig-isolation reason as the types above).
 */
export interface MemoryFactPayload {
	id: string;
	text: string;
	ts: number;
	layer: 'working' | 'knowledge';
	source: 'explicit' | 'extracted';
	confirmations: number;
	lastSeenTs: number;
}
