/**
 * The `/miniapp/*` sub-router (docs/adr/0036) maps method/path pairs to
 * authenticated handlers. `Entry.fetch` calls
 * `handleMiniappRequest` once for any path under the prefix; unmatched
 * method/suffix pairs 404 uniformly, same as the rest of the app's routes.
 */
import { handleBookmarks } from '../assets/http';
import { getAgentByName } from 'agents';
import type { Env } from '../../core/env';
import type { Bot } from '../../core/bot';
import type { Capability } from '../../core/principal';
import { resolvePrincipal } from '../../core/principal';
import { syncCommands } from '../../core/sync-commands';
import { verifyInitData } from './telegram-auth';
import { getGlobalConfig, setEmailHtmlParser, type HtmlParserKind } from '../ai/global-config';
import { isReasoningEffort } from '../ai/reasoning-effort';
import { emailRepository, toEmailSummary } from '../email/repository';
import { buildEmailPreviewData } from '../email/preview';
import { ALL_CAPABILITIES } from './contract';

/**
 * Verify a shell POST's `initData` and resolve its Principal (ADR-0036):
 * parses the body, checks the HMAC + staleness (`verifyInitData`), then
 * requires the same `use_commands` bar as any other command. Returns `null`
 * on any failure (bad body, bad `initData`, or an unauthorized Principal), so
 * every endpoint rejects uniformly; never throws on a malformed body.
 *
 * Per-screen capability checks (`view_debug`, `schedule_turns`, `manage_email`)
 * are *not* here — the dispatcher enforces each route's declared `capability`
 * (see `AUTHED_ROUTES`) before the handler runs, so the whole surface's auth
 * policy is one table rather than a guard smeared across every handler body.
 */
async function authorizeMiniappRequest(request: Request, env: Env) {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const body = parsed as Record<string, unknown>;
	if (typeof body.initData !== 'string') return null;

	const verified = await verifyInitData(env.TELEGRAM_API_TOKEN, body.initData);
	if (!verified) return null;

	// Private-chat convention (docs/adr/0031, `resolveAdminId`): a chat's id
	// equals the user's id. Group chats aren't reachable from the global Menu
	// Button, so this is out of scope by construction (ADR-0036).
	const principal = await resolvePrincipal(verified.userId, verified.userId, env);
	if (!principal.can('use_commands')) return null;

	const agent = await getAgentByName(env.ConversationAgent, String(verified.userId));
	return { agent, body, principal };
}

/** The authorized context an `AuthedHandler` receives — Principal + agent + parsed body. */
type AuthorizedRequest = NonNullable<Awaited<ReturnType<typeof authorizeMiniappRequest>>>;

/**
 * A route handler that runs only after `initData`, the `use_commands` bar, and
 * its declared `capability` all pass. Receives the request-scoped `Bot` (built
 * once in `index.fetch` with the full command registry) so a handler can act on
 * it without route.ts importing the entry-point registry (avoids a cycle).
 */
type AuthedHandler = (auth: AuthorizedRequest, env: Env, bot: Bot) => Promise<Response>;

async function handleBootstrap(auth: AuthorizedRequest): Promise<Response> {
	const canViewDebug = auth.principal.can('view_debug');
	const canScheduleTurns = auth.principal.can('schedule_turns');
	const [settings, schedules] = await Promise.all([
		auth.agent.settingsSnapshot(),
		canScheduleTurns ? auth.agent.listScheduledView() : Promise.resolve(undefined),
	]);
	return Response.json({
		capabilities: ALL_CAPABILITIES.filter((c) => auth.principal.can(c)),
		language: settings.language,
		htmlParser: settings.htmlParser,
		...(canViewDebug ? { debug: settings.debug } : {}),
		schedules,
	});
}

async function handleGlobalServiceData(_auth: AuthorizedRequest, env: Env): Promise<Response> {
	const config = await getGlobalConfig(env.STATE);
	return Response.json({
		emailHtmlParser: config.emailHtmlParser,
	});
}

async function handleGlobalServiceHtmlParserSet(auth: AuthorizedRequest, env: Env): Promise<Response> {
	const { parser } = auth.body;
	if (parser !== 'turndown' && parser !== 'ai') return Response.json({ error: 'invalid html parser' }, { status: 400 });
	const config = await setEmailHtmlParser(env.STATE, parser as HtmlParserKind);
	return Response.json({ ok: true, emailHtmlParser: config.emailHtmlParser });
}

// ── Chat settings (docs/adr/0036, use_commands): a chat's own reasoning ──
// effort, compaction token threshold, and memory retrieval count — each
// user edits their own chat's settings with use_commands.

async function handleChatSettingsData(auth: AuthorizedRequest): Promise<Response> {
	const settings = await auth.agent.settingsSnapshot();
	return Response.json({
		reasoningEffort: settings.reasoning,
		compactionThreshold: settings.compactionThreshold,
		memoryTopK: settings.memoryTopK,
	});
}

async function handleChatReasoningSet(auth: AuthorizedRequest): Promise<Response> {
	const { effort } = auth.body;
	if (!isReasoningEffort(effort)) return Response.json({ error: 'invalid reasoning effort' }, { status: 400 });
	await auth.agent.updateSettings({ reasoning: effort });
	return Response.json({ ok: true, reasoningEffort: effort });
}

/** `value` from the client is `number | null | undefined` over JSON — `null`/absent clears back to the hardcoded default. */
function parseOptionalPositiveNumber(value: unknown): number | null | undefined {
	if (value === null || value === undefined) return null;
	return typeof value === 'number' ? value : undefined;
}

async function handleChatCompactionSet(auth: AuthorizedRequest): Promise<Response> {
	const tokens = parseOptionalPositiveNumber(auth.body.tokens);
	if (tokens === undefined) return Response.json({ error: 'invalid tokens' }, { status: 400 });
	const settings = await auth.agent.updateSettings({ compactionThreshold: tokens });
	return Response.json({ ok: true, compactionThreshold: settings.compactionThreshold });
}

async function handleChatMemoryTopKSet(auth: AuthorizedRequest): Promise<Response> {
	const topK = parseOptionalPositiveNumber(auth.body.topK);
	if (topK === undefined) return Response.json({ error: 'invalid topK' }, { status: 400 });
	const settings = await auth.agent.updateSettings({ memoryTopK: topK });
	return Response.json({ ok: true, memoryTopK: settings.memoryTopK });
}

async function handleLanguageSet(auth: AuthorizedRequest): Promise<Response> {
	const { value } = auth.body;
	if (typeof value !== 'string') return Response.json({ error: 'invalid value' }, { status: 400 });
	// Free-form language instruction; blank, "reset", and "clear" unset it (docs/adr/0025).
	const trimmed = value.trim();
	const stored = !trimmed || ['reset', 'clear'].includes(trimmed.toLowerCase()) ? null : trimmed;
	await auth.agent.updateSettings({ language: stored });
	const message = stored ? `🌐 Reply language set to: ${stored}` : 'Reply language cleared.';
	return Response.json({ ok: true, stored, message });
}

async function handleHtmlParserSet(auth: AuthorizedRequest): Promise<Response> {
	const { value } = auth.body;
	if (typeof value !== 'string' || !['turndown', 'ai'].includes(value)) return Response.json({ error: 'invalid value' }, { status: 400 });
	const settings = await auth.agent.updateSettings({ htmlParser: value as 'turndown' | 'ai' });
	return Response.json({ ok: true, htmlParser: settings.htmlParser });
}

// `view_debug` is enforced by the dispatcher from `AUTHED_ROUTES` before this
// runs — the server-side re-check the client's tab-hiding never substitutes for
// (docs/adr/0036).
async function handleDebugSet(auth: AuthorizedRequest): Promise<Response> {
	const { enabled } = auth.body;
	if (typeof enabled !== 'boolean') return Response.json({ error: 'invalid value' }, { status: 400 });
	await auth.agent.updateSettings({ debug: enabled });
	return Response.json({ ok: true, enabled });
}

async function handleScheduleCancel(auth: AuthorizedRequest): Promise<Response> {
	const { id } = auth.body;
	if (typeof id !== 'string') return Response.json({ error: 'invalid id' }, { status: 400 });
	const cancelled = await auth.agent.cancelScheduledTurn(id);
	const schedules = await auth.agent.listScheduledView();
	return Response.json({ ok: true, cancelled, schedules });
}

/**
 * Manual "Sync commands" button in the Settings shell (docs/adr/0037): pushes
 * the current command registry to Telegram on demand, for when you don't want
 * to wait for the deploy-time auto-sync (`index.scheduled`). `admin_ops`-gated
 * (declared in `AUTHED_ROUTES`), matching the removed `/sync_commands` command's
 * old admin bar.
 */
async function handleCommandsSync(_auth: AuthorizedRequest, env: Env, bot: Bot): Promise<Response> {
	await syncCommands(bot, env);
	return Response.json({ ok: true });
}

/** Most recent emails listed in the Email tab (docs/adr/0035) — no pagination/filtering. */
const EMAIL_LIST_LIMIT = 30;

async function handleEmailList(_auth: AuthorizedRequest, env: Env): Promise<Response> {
	const rows = await emailRepository.listRecent(env, EMAIL_LIST_LIMIT);
	return Response.json({ emails: rows.map(toEmailSummary) });
}

/**
 * The Email tab's detail screen (docs/adr/0035): given an id, parses the
 * stored `.eml` from R2 (`emailRepository.getParsed`, per request). The shell
 * renders its JSON payload into a sandboxed `srcdoc` iframe. This is also the endpoint behind
 * the deep-linked `?screen=email&id=<id>` cold launch from the triage DM's
 * View button.
 */
async function handleEmailData(auth: AuthorizedRequest, env: Env): Promise<Response> {
	const { id } = auth.body;
	if (typeof id !== 'number' && typeof id !== 'string') return Response.json({ error: 'invalid id' }, { status: 400 });
	const emailId = Number(id);
	if (!Number.isInteger(emailId) || emailId <= 0) return Response.json({ error: 'invalid id' }, { status: 400 });
	const row = await emailRepository.getById(env, emailId);
	if (!row) return Response.json({ error: 'not found' }, { status: 404 });
	// A parse/R2 miss degrades to header-only data, never an error response.
	const parsed = await emailRepository.getParsed(env, row.r2Key);
	const email = buildEmailPreviewData(parsed, {
		// Prefer the freshly-parsed decoded subject; fall back to decoding the stored
		// header so legacy rows (raw `=?UTF-8?B?…?=`) still render decoded.
		subject: parsed?.subject || row.subject || 'No Subject',
		from: row.fromAddr,
		to: row.toAddr,
		date: row.date || '',
		spam: row.spam === 1,
		authResults: row.authResults ?? null,
	});
	return Response.json({ email });
}

/**
 * The Memory tab (docs/adr/0038): list this private chat's Long-term memory
 * facts, both layers. No capability beyond `use_commands` — memory is the chat
 * owner's own data, same bar as `/forget`. `chatId == userId` by the private-chat
 * convention, so a group chat's memory is unreachable here by construction.
 */
async function handleMemoryList(auth: AuthorizedRequest): Promise<Response> {
	const memories = await auth.agent.listMemories(auth.principal.chatId);
	return Response.json({ memories });
}

/** The Memory tab's Forget-all: the same both-layers wipe `/forget` runs. */
async function handleMemoryForget(auth: AuthorizedRequest): Promise<Response> {
	const count = await auth.agent.forget(auth.principal.chatId);
	return Response.json({ ok: true, count });
}

/** One authenticated route: the handler, plus the extra `capability` (beyond `use_commands`) the dispatcher enforces. */
interface AuthedRoute {
	/** Required beyond the base `use_commands` bar; omitted = no extra gate (Model, Language). */
	capability?: Capability;
	handler: AuthedHandler;
}

/**
 * The whole Mini App auth policy as one table (docs/adr/0036): every
 * authenticated `/miniapp/settings/*` route with the capability it demands.
 * The dispatcher verifies `initData` + `use_commands`, enforces `capability`,
 * then runs the handler — so a new route can't silently forget its check, and
 * the check-per-tab lives *next to* the route rather than buried in a body.
 * The unauthenticated SPA itself (`GET /miniapp/*`) is served by Workers
 * Static Assets, wired in `index.ts` rather than here — its whole point is
 * loading before any `initData` exists (ADR-0036).
 */
const AUTHED_ROUTES: Record<string, AuthedRoute> = {
	...Object.fromEntries(['list', 'detail', 'file', 'delete', 'retry'].map((action) => [
		`POST /settings/bookmarks/${action}`,
		{ handler: (auth: AuthorizedRequest, env: Env) => handleBookmarks(env, auth.principal, auth.body, action) },
	])),
	'POST /settings/data': { handler: handleBootstrap },
	'POST /settings/language/set': { handler: handleLanguageSet },
	'POST /settings/html-parser/set': { handler: handleHtmlParserSet },
	'POST /settings/debug/set': { capability: 'view_debug', handler: handleDebugSet },
	'POST /settings/schedules/cancel': { capability: 'schedule_turns', handler: handleScheduleCancel },
	'POST /settings/email/list': { capability: 'manage_email', handler: handleEmailList },
	'POST /settings/email/data': { capability: 'manage_email', handler: handleEmailData },
	'POST /settings/commands/sync': { capability: 'admin_ops', handler: handleCommandsSync },
	'POST /settings/memory/list': { handler: handleMemoryList },
	'POST /settings/memory/forget': { handler: handleMemoryForget },
	'POST /settings/global-service/data': { capability: 'admin_ops', handler: handleGlobalServiceData },
	'POST /settings/global-service/html-parser/set': { capability: 'admin_ops', handler: handleGlobalServiceHtmlParserSet },
	'POST /settings/chat-settings/data': { handler: handleChatSettingsData },
	'POST /settings/chat-settings/reasoning/set': { handler: handleChatReasoningSet },
	'POST /settings/chat-settings/compaction/set': { handler: handleChatCompactionSet },
	'POST /settings/chat-settings/memory-top-k/set': { handler: handleChatMemoryTopKSet },
};

/**
 * Dispatch a `POST` request under `/miniapp/settings/*`. `path` is the full
 * request path (e.g. `/miniapp/settings/data`); the `/miniapp` prefix is
 * stripped before the method+suffix lookup. The SPA itself (`GET /miniapp/*`,
 * docs/adr/0036) is served by Workers Static Assets before this router ever
 * runs — see `index.ts`'s dispatch. Every route here runs the shared auth
 * pipeline (`initData` → `use_commands` → declared `capability`) once, before
 * its handler. Unmatched routes 404, matching every other route's
 * uniform-rejection convention in this app.
 */
export async function handleMiniappRequest(request: Request, env: Env, path: string, bot: Bot): Promise<Response> {
	const key = `${request.method} ${path.slice('/miniapp'.length)}`;

	const route = AUTHED_ROUTES[key];
	if (!route) return new Response('Not found', { status: 404 });

	const auth = await authorizeMiniappRequest(request, env);
	if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 });
	if (route.capability && !auth.principal.can(route.capability)) {
		return Response.json({ error: 'forbidden' }, { status: 403 });
	}
	return route.handler(auth, env, bot);
}
