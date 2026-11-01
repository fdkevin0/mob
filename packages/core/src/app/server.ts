// The local HTTP API: the AI SDK UI chat stream, conversations, commands,
// plugins and the change feed, behind the access token. Written against the
// Fetch API, so Bun serves it on a computer and a service worker in a browser.
import type { Command, CommandCall, CommandRequest, Suggestion } from '../chat/commands';
import { cell, choices, interactive, openPlugins, replyJSON } from '../chat/commands';
import { ConversationService, CommandError, type ChatRequest } from '../chat/conversation';
import type { Answer } from '../chat/delegate';
import type { Hooks } from '../chat/engine';
import { encode, type Event } from '../chat/events';
import type { Running } from '../chat/running';
import type { Entry } from '../chat/search';
import { NotFound, newID } from '../chat/sql';
import { isConversationID, TransferError, type Store, type Task, type Transfer, type UsageSummary } from '../chat/store';
import { jsonSchema, type Tool } from '../chat/tools';
import { isLoopbackHost, secureURL } from '../url';
import { publicProvider } from '../provider/provider';
import { providerFromForm, saveProvider, type ProviderForm } from '../provider/save';
import type { ProviderRegistry } from '../provider/registry';
import { PluginSettings, type Section } from './configuration';
import { Extensions, ExtensionsClosed, type Extension } from './extension';
import { Hono } from 'hono';
import { api, bearer, chatBody } from './api';
import { HTTPError, answerError, body, failure, json, sse, text } from './http';

/** Route is a plugin's API route under /api/plugins/NAME/. */
export type Route = { method: string; path: string; handle: (req: Request) => Promise<unknown> };

/** Plugin is what one plugin adds to Mob. Each reads the saved configuration whenever it needs it. */
export type Plugin = {
	name: string;
	section?: Section;
	commands?: Command[];
	tools?: Tool[];
	routes?: Route[];
	hooks?: Partial<Hooks>;
	/** source lists tools that change while Mob runs. */
	source?: () => Tool[];
	/** entries lists what tool_search finds besides tools. */
	entries?: () => Entry[];
	/** background is set for a plugin that runs while it is enabled. */
	background?: Extension;
};

/** AgentApproval is a decision waiting in an agent's conversation. */
export type AgentApproval = {
	id: string;
	tool: string;
	/** text is what is asked: one "field: value" line per input field, so that a command shows in full rather than only its title. */
	text: string;
	/** whole is false when a field was too long to show; the owner then decides in the conversation. */
	whole: boolean;
};

/** AgentNode is one conversation in the task tree (GET /api/tasks): a task, or a conversation of Mob's that started tasks. */
export type AgentNode = {
	conversationId: string;
	/** parent is the conversation that started this one; unset for a root. */
	parent?: string;
	/** agent is the task's agent, or mob; label is its display name. */
	agent: string;
	label: string;
	/** model is the model the agent runs: the one its running session's options select, else the one that used the most tokens. */
	model?: string;
	title: string;
	/** status is a task status, or running, waiting or idle for Mob. */
	status: string;
	/** approvals are the decisions that wait for the owner, oldest first. */
	approvals: AgentApproval[];
	/** tools are the kinds of tool the agent used, such as execute or edit. */
	tools: string[];
	task?: Task;
	usage?: UsageSummary;
};

/** Tasks is the coding agent service as the API reaches it. */
export interface Tasks {
	tree(project: string): AgentNode[];
	stopTask(id: string): void;
	message(id: string, text: string, signal?: AbortSignal): Promise<void>;
}

export type ServerOptions = {
	store: Store;
	providers: ProviderRegistry;
	token: string;
	version: string;
	/** persistToken saves a rotated token; unset when the token comes from configuration. */
	persistToken?: (token: string) => void | Promise<void>;
	/** shutdown is set for a background service, which the API may stop. */
	shutdown?: () => void;
	configurationError?: () => string;
	/** assets serves the web UI; undefined falls through to 404. */
	assets?: (path: string) => Response | undefined | Promise<Response | undefined>;
};

const eventsHeartbeat = 25_000;

const loopbackHost = (host: string) => {
	const h = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
	return isLoopbackHost(h);
};

/** allowedOrigin: the desktop window and the service's own pages are same-origin; the Vite dev server may call too. */
const allowedOrigin = (origin: string, host: string) => !origin || origin === 'http://' + host || origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173';

/** webOrigin is the origin a web_url's pages send, or '' when it is empty or invalid. */
export function webOrigin(raw: string): string {
	if (!raw) return '';
	let u: URL;
	try { u = new URL(raw); } catch { throw new Error('web_url must be an https URL without credentials, query or fragment'); }
	const ok = !u.username && !u.password && !u.search && !raw.includes('?') && !raw.includes('#') && secureURL(u);
	if (!ok) throw new Error('web_url must be an https URL without credentials, query or fragment');
	return u.origin;
}

export class Server extends ConversationService {
	readonly settings: PluginSettings;
	readonly extensions = new Extensions();
	tasks?: Tasks;
	private token: string;
	/** revoked aborts when the token is replaced, ending every request it authorized. */
	revoked = new AbortController();
	/** codes are the pairing codes not yet claimed, with when they expire. */
	readonly codes = new Map<string, number>();
	private web = '';
	private closed = new AbortController();
	private plugins: Plugin[] = [];
	private pluginRoutes: Route[] = [];
	private pluginApp?: Hono;

	constructor(readonly options: ServerOptions, plugins: Plugin[] = []) {
		super(options.store, options.providers);
		this.token = options.token;
		this.settings = new PluginSettings(options.store, []);
		this.commands.register(...this.pluginCommands());
		this.register(...plugins);
	}

	get providers() { return this.options.providers; }
	currentToken() { return this.token; }

	/** register adds each plugin's contributions before serving conversations. */
	register(...plugins: Plugin[]) {
		for (const p of plugins) {
			this.plugins.push(p);
			if (p.section) this.settings.sections.push(p.section);
			this.commands.register(...p.commands ?? []);
			this.tools.register(...p.tools ?? []);
			this.hooks.beforeTurn.push(...p.hooks?.beforeTurn ?? []);
			this.hooks.beforeTool.push(...p.hooks?.beforeTool ?? []);
			this.hooks.afterTurn.push(...p.hooks?.afterTurn ?? []);
			if (p.source) this.tools.registerSource(p.source);
			if (p.entries) this.tools.registerEntries(p.entries);
			if (p.background) this.extensions.register(p.background);
			// Plugins may join after the server answered requests, so their routes are a router of their own, built again on each.
			for (const route of p.routes ?? []) this.pluginRoutes.push({ ...route, path: `/api/plugins/${p.name}/${route.path.replace(/\{(\w+)\}/g, ':$1')}` });
			this.pluginApp = undefined;
		}
	}

	startPlugins() { return this.extensions.startAll(); }

	/** setWebURL lets the pages of the public web UI call the API; they still need the token. */
	setWebURL(raw: string) { try { this.web = webOrigin(raw); } catch { this.web = ''; } }

	async close() {
		this.closed.abort();
		await this.extensions.close();
		await super.close();
	}

	private pluginCommands(): Command[] {
		const spec = (name: string, usage: string, summary: string) => ({ name, usage, summary, clients: interactive });
		const plugins = () => this.settings.sections.map(s => ({ value: s.name, label: s.name }));
		const secrets = (_: CommandCall, prior: string[]): Suggestion[] => choices(...this.settings.lookup(prior[0])?.secrets.map(s => s.name) ?? [])(_, prior) as Suggestion[];
		return [
			{ ...spec('plugins', '/plugins', 'Configure plugins and cloud services'), run: async () => ({ action: { kind: openPlugins } }) },
			{
				...spec('test', '/test PLUGIN', 'Test a plugin connection'), ownerOnly: true, args: [plugins],
				run: async call => {
					if (call.fields.length !== 1) return { markdown: 'Use `/test ' + this.settings.sections.map(s => s.name).join('|') + '`.' };
					const name = call.fields[0];
					try {
						return replyJSON('**' + cell(name) + '** connection works.', await this.testPlugin(name, call.signal));
					} catch (e) {
						if (e instanceof CommandError) return { markdown: e.message + '.' };
						return { markdown: '**' + cell(name) + '** connection failed: ' + (e as Error).message };
					}
				},
			},
			{
				...spec('deliveries', '/deliveries', 'Show channel delivery status'),
				run: async () => {
					const rows = this.store.deliveries();
					if (!rows.length) return { markdown: 'No deliveries yet.' };
					let b = '| Delivery | State | Updated | Error |\n| --- | --- | --- | --- |\n';
					for (const d of rows) {
						const updated = d.updatedAt > 0 ? new Date(d.updatedAt).toISOString().replace('T', ' ').slice(0, 19) : 'unknown';
						b += `| \`${d.id}\` | ${cell(d.state)} | ${updated} | ${cell(d.error)} |\n`;
					}
					return { markdown: b + '\nUncertain or interrupted sends are never retried automatically.' };
				},
			},
			{
				...spec('clear-secret', '/clear-secret PLUGIN FIELD', 'Clear a saved credential of a disabled plugin'), ownerOnly: true, args: [plugins, secrets],
				run: async call => {
					const help = 'Use `/clear-secret PLUGIN FIELD` after disabling the plugin, e.g. `/clear-secret email imap.password`.';
					if (call.fields.length !== 2) return { markdown: help };
					const [name, field] = call.fields;
					if (!this.settings.lookup(name)) return { markdown: help };
					const body = { ...this.settings.publicConfig()[name], secrets: { [field]: { mode: 'clear' } } };
					try { await this.updatePlugin(name, body); } catch (e) {
						if (e instanceof CommandError) throw e;
						return { markdown: 'Cannot clear ' + cell(field) + ': ' + (e as Error).message };
					}
					return { markdown: 'Cleared the saved ' + cell(field) + ' of ' + name + '.' };
				},
			},
		];
	}

	/** testPlugin checks an enabled plugin's connection. */
	async testPlugin(name: string, signal?: AbortSignal) {
		const section = this.settings.lookup(name);
		if (!section) throw new CommandError(404, 'unknown plugin ' + name);
		const c = this.settings.config()[name];
		if (!section.enabled(c)) throw new CommandError(409, section.label + ' is disabled');
		const timeout = AbortSignal.timeout(30_000);
		return section.test(c, signal ? AbortSignal.any([signal, timeout]) : timeout);
	}

	/** updatePlugin saves one plugin's configuration and restarts it if it runs in the background. */
	async updatePlugin(name: string, raw: Record<string, unknown>) {
		if (this.extensions.isClosed()) throw new CommandError(503, 'service is stopping');
		const c = this.settings.update(name, raw);
		try { await this.extensions.reload(name); } catch (e) { if (!(e instanceof ExtensionsClosed)) throw e; }
		return c;
	}

	// Access.

	/** rotateToken replaces the token, persisting it first, and invalidates pending pairing codes. */
	async rotateToken(allowed: (current: string) => boolean) {
		if (!this.options.persistToken) throw new HTTPError(409, 'the access token is supplied through configuration; change it there and restart Mob');
		if (!allowed(this.token)) throw new HTTPError(401, 'unauthorized');
		const next = newID() + newID();
		await this.options.persistToken(next);
		this.token = next;
		this.codes.clear();
		this.revoked.abort();
		this.revoked = new AbortController();
	}

	/** stream follows the turn running in conversation id, resuming after the client's Last-Event-ID. */
	stream(req: Request, id: string) {
		const running = this.watch(id);
		if (!running) return new Response(null, { status: 204 });
		return follow(req, running, Math.max(Number.parseInt(req.headers.get('Last-Event-ID') ?? '0', 10) || 0, 0));
	}

	/** chat starts a turn from a chat request and streams it. */
	chat = async (req: Request) => {
		let input: ChatRequest;
		try {
			// Only a defence against runaway bodies: the model's context bounds a message.
			input = await body<ChatRequest>(req, chatBody, ['id', 'text', 'requestId', 'approval', 'replace']);
		} catch { return text(400, 'invalid chat request'); }
		// Holders of the local token run this Mob.
		input = { id: input.id, text: input.text ?? '', requestId: input.requestId ?? '', approval: input.approval, replace: input.replace, owner: true };
		let running: Running;
		try {
			// The turn belongs to the service now, but a replaced token still ends it.
			running = await this.start(input, this.revoked.signal);
		} catch (e) {
			if (e instanceof Error && e.name === 'Aborted') return text(409, 'the turn was stopped before it began');
			return failure(e);
		}
		return follow(req, running, 0);
	};

	/**
	 * events streams what changed in the store, so clients reload only what
	 * changed instead of polling. A client reloads everything when it connects.
	 */
	events(req: Request) {
		return sse({ 'Cache-Control': 'no-store' }, async (send, signal) => {
			send('retry: 2000\n: ready\n\n');
			const stop = this.store.changes.subscribe(change => send(`data: ${JSON.stringify(change)}\n\n`));
			const heartbeat = setInterval(() => send(': ping\n\n'), eventsHeartbeat);
			await new Promise<void>(resolve => {
				if (signal.aborted || this.closed.signal.aborted) return resolve();
				signal.addEventListener('abort', () => resolve(), { once: true });
				this.closed.signal.addEventListener('abort', () => resolve(), { once: true });
			});
			clearInterval(heartbeat);
			stop();
		}, AbortSignal.any([req.signal, this.revoked.signal]));
	}

	/** fetch serves one request. */
	fetch = async (req: Request): Promise<Response> => this.app.fetch(req);

	private app = new Hono()
		.use(async (c, next) => {
			const url = new URL(c.req.url);
			const headers = new Headers({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
			const done = () => { c.res = withHeaders(c.res, headers); };
			const origin = c.req.header('Origin') ?? '';
			const host = c.req.header('Host') ?? url.host;
			if (!allowedOrigin(origin, host) && (!origin || origin !== this.web)) { c.res = text(403, 'origin denied'); return done(); }
			if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin'); }
			if (c.req.method === 'OPTIONS') {
				headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
				headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
				// Chrome asks before a public page may reach a loopback address.
				if (c.req.header('Access-Control-Request-Private-Network') === 'true') headers.set('Access-Control-Allow-Private-Network', 'true');
				c.res = new Response(null, { status: 204 });
				return done();
			}
			if (url.pathname.startsWith('/api/')) {
				headers.set('Cache-Control', 'no-store');
				if (url.pathname !== '/api/pairing/claim' && !bearer(c.req.header('Authorization'), this.token)) { c.res = text(401, 'unauthorized'); return done(); }
			}
			// Reject arbitrary Host headers too, preventing DNS rebinding against a local service.
			if (!loopbackHost(host)) { c.res = text(403, 'host denied'); return done(); }
			await next();
			done();
		})
		.route('/', api(this))
		.all('/api/plugins/*', c => (this.pluginApp ??= pluginRouter(this.pluginRoutes)).fetch(c.req.raw))
		.notFound(async c => (!c.req.path.startsWith('/api/') && await this.options.assets?.(c.req.path)) || text(404, '404 page not found'))
		.onError(e => answerError(e));
}

/** pluginRouter answers plugins' routes; a path a plugin serves by another method answers 405. */
function pluginRouter(routes: Route[]) {
	const app = new Hono();
	for (const r of routes) {
		app.on(r.method, r.path, async c => {
			try { return json(200, await r.handle(c.req.raw)); } catch (e) { return failure(e, 502); }
		});
	}
	for (const path of new Set(routes.map(r => r.path))) app.all(path, () => text(405, 'method not allowed'));
	app.notFound(() => text(404, '404 page not found'));
	return app;
}

function withHeaders(response: Response, headers: Headers) {
	// A response may come with immutable headers, such as one fetched; copy it then.
	try { for (const [k, v] of headers) if (!response.headers.has(k)) response.headers.set(k, v); } catch {
		response = new Response(response.body, response);
		for (const [k, v] of headers) if (!response.headers.has(k)) response.headers.set(k, v);
	}
	return response;
}

/** follow streams a turn's events until it ends. A client that leaves ends only its own stream, never the turn. */
function follow(req: Request, running: Running, after: number) {
	return sse({ 'x-vercel-ai-ui-message-stream': 'v1' }, async (send, signal) => {
		await running.follow(after, (seq, e: Event) => send(`id: ${seq}\ndata: ${JSON.stringify(encode(e))}\n\n`), signal);
		if (!signal.aborted) send('data: [DONE]\n\n');
	}, req.signal);
}
