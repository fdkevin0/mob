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
import { isConversationID, TransferError, type Store, type Transfer } from '../chat/store';
import type { Tool } from '../chat/tools';
import { publicProvider } from '../provider/provider';
import { providerFromForm, saveProvider, type ProviderForm } from '../provider/save';
import type { ProviderRegistry } from '../provider/registry';
import { PluginSettings, type Section } from './configuration';
import { Extensions, ExtensionsClosed, type Extension } from './extension';
import { HTTPError, Router, body, failure, json, sse, text } from './http';

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

/** Tasks is the coding agent service as the API reaches it. */
export interface Tasks {
	tree(project: string): unknown;
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

const pairingLifetime = 5 * 60_000;
const chatBody = 8 << 20;
const transferBody = 64 << 20;
// titleLimit is how long a title an owner gives a conversation may be.
const titleLimit = 200;
const eventsHeartbeat = 25_000;

const bearer = (header: string | null, token: string) => {
	if (!token || !header) return false;
	const want = 'Bearer ' + token;
	if (header.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= header.charCodeAt(i) ^ want.charCodeAt(i);
	return diff === 0;
};

const loopbackHost = (host: string) => {
	const h = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
	return h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1';
};

/** allowedOrigin: the desktop window and the service's own pages are same-origin; the Vite dev server may call too. */
const allowedOrigin = (origin: string, host: string) => !origin || origin === 'http://' + host || origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173';

/** webOrigin is the origin a web_url's pages send, or '' when it is empty or invalid. */
export function webOrigin(raw: string): string {
	if (!raw) return '';
	let u: URL;
	try { u = new URL(raw); } catch { throw new Error('web_url must be an https URL without credentials, query or fragment'); }
	const host = u.hostname.toLowerCase();
	const ok = !u.username && !u.password && !u.search && !raw.includes('?') && !raw.includes('#') &&
		(u.protocol === 'https:' || (u.protocol === 'http:' && (host === 'localhost' || /^127\./.test(host) || host === '[::1]')));
	if (!ok) throw new Error('web_url must be an https URL without credentials, query or fragment');
	return u.origin;
}

export class Server extends ConversationService {
	readonly settings: PluginSettings;
	readonly extensions = new Extensions();
	tasks?: Tasks;
	private token: string;
	/** revoked aborts when the token is replaced, ending every request it authorized. */
	private revoked = new AbortController();
	private codes = new Map<string, number>();
	private web = '';
	private closed = new AbortController();
	private plugins: Plugin[] = [];

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
			// The router exists before any plugin, so each plugin's routes join it as the plugin does.
			for (const route of p.routes ?? []) {
				this.routes.handle(`${route.method} /api/plugins/${p.name}/${route.path}`, async req => {
					try { return json(200, await route.handle(req)); } catch (e) { return failure(e, 502); }
				});
			}
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

	private router(): Router {
		const r = new Router();
		const s = this;
		r.handle('GET /api/runtime', () => json(200, { background: !!s.options.shutdown, configError: s.options.configurationError?.() ?? '', version: s.options.version }));
		r.handle('POST /api/runtime/stop', () => {
			if (!s.options.shutdown) return text(409, 'service belongs to a foreground/UI process');
			queueMicrotask(() => s.options.shutdown!());
			return json(202, { stopping: true });
		});
		r.handle('GET /api/memories', () => json(200, s.store.facts()));
		r.handle('POST /api/memories/{id}/delete', (_, p) => json(200, { removed: s.store.forget(p.id) }));
		r.handle('GET /api/grants', () => json(200, s.store.grants()));
		r.handle('POST /api/grants/{id}/delete', (_, p) => json(200, { removed: s.store.revoke(p.id) }));
		r.handle('GET /api/deliveries', () => json(200, s.store.deliveries()));
		r.handle('GET /api/plugins', () => json(200, {
			config: s.settings.publicConfig(), sections: s.settings.sections.map(({ name, title, fields, secrets }) => ({ name, title, fields, secrets: secrets.map(x => x.name) })),
			telegramStatus: s.extensions.status('telegram'), emailStatus: s.extensions.status('email'), wechatStatus: s.extensions.status('wechat_ilink'),
		}));
		r.handle('POST /api/plugins/{plugin}', async (req, p) => {
			try {
				return json(200, s.settings.publicConfig(await s.updatePlugin(p.plugin, await body(req))));
			} catch (e) { return failure(e, 400); }
		});
		r.handle('POST /api/plugins/{plugin}/test', async (req, p) => {
			try { return json(200, await s.testPlugin(p.plugin, req.signal)); } catch (e) { return failure(e, 502); }
		});
		r.handle('GET /api/config', () => json(200, { defaultModel: s.providers.default(), demo: s.providers.demo }));
		r.handle('GET /api/models', async (req, _, url) => json(200, await s.providers.list(url.searchParams.get('q') ?? '', req.signal)));
		r.handle('GET /api/providers', () => {
			const f = s.providers.providers();
			return json(200, { default: f.default ?? '', providers: f.providers.map(publicProvider) });
		});
		// The web's Model provider dialog saves a provider here, as `mob provider add` does on the command line.
		r.handle('POST /api/providers', async req => {
			const form = await body<ProviderForm>(req, 16 << 10, ['preset', 'url', 'protocol', 'key', 'model']);
			return json(200, await saveProvider(s.providers, providerFromForm(form), typeof form.model === 'string' ? form.model : undefined));
		});
		r.handle('GET /api/conversations', () => {
			// The list says which conversations are replying or waiting for a decision, so a client can mark them.
			const waiting = s.store.waiting();
			return json(200, s.store.list().map(c => ({ ...c, active: s.isActive(c.id), waiting: waiting.has(c.id) })));
		});
		r.handle('POST /api/conversations', () => json(200, s.store.create()));
		r.handle('GET /api/conversations/{id}', (_, p) => {
			// A conversation a client named but has not said anything in yet is empty until its first message.
			if (!s.store.exists(p.id) && isConversationID(p.id)) return json(200, { messages: [], active: false, model: s.providers.default() });
			// A client showing the snapshot must not offer a decision on an approval that has expired.
			s.store.expireApprovals(p.id);
			return json(200, { messages: s.store.history(p.id).map(m => ({ id: m.id, role: m.role, parts: m.parts, metadata: m.metadata })), active: s.isActive(p.id), model: s.model(p.id) });
		});
		r.handle('GET /api/conversations/{id}/context', (_, p) => {
			// A conversation a client named but has not said anything in yet is estimated empty.
			if (!s.store.exists(p.id) && !isConversationID(p.id)) throw new NotFound();
			return json(200, { context: s.context(p.id, true) ?? null, usage: s.store.conversationUsage(p.id).get(p.id) });
		});
		r.handle('POST /api/conversations/{id}/rename', async (req, p) => {
			const input = await body<{ title?: unknown }>(req, 4 << 10, ['title']);
			const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
			if (!title || [...title].length > titleLimit) throw new HTTPError(400, `A title has 1 to ${titleLimit} characters.`);
			s.store.rename(p.id, title);
			return json(200, { id: p.id, title });
		});
		// Choosing a model is a setting of the conversation, for its later replies; it adds nothing to the transcript.
		r.handle('POST /api/conversations/{id}/model', async (req, p) => {
			const input = await body<{ model?: unknown }>(req, 4 << 10, ['model']);
			if (typeof input.model !== 'string') throw new HTTPError(400, 'model must be a provider/model reference, or empty for the default.');
			return json(200, { model: s.setModel(p.id, input.model.trim()) });
		});
		r.handle('POST /api/conversations/{id}/delete', (_, p) => {
			if (s.isActive(p.id)) throw new HTTPError(409, 'Mob is still replying in this conversation; stop it before deleting the conversation.');
			s.store.remove(p.id);
			return json(200, { deleted: true });
		});
		r.handle('GET /api/usage', (_, __, url) => {
			// days limits the report to the last whole days, today included; 0 or none covers everything.
			const days = Number.parseInt(url.searchParams.get('days') ?? '', 10);
			let since = 0;
			if (days > 0) { const now = new Date(); since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime(); }
			return json(200, s.store.report(since, 20));
		});
		// A conversation moves between Mobs, such as from the browser to a runner, as an export here and an import there.
		r.handle('GET /api/conversations/{id}/export', (_, p) => {
			if (s.isActive(p.id)) throw new HTTPError(409, 'Mob is still replying in this conversation; wait for it or stop it before moving the conversation.');
			try { return json(200, s.store.exportConversation(p.id)); } catch (e) { if (e instanceof TransferError) throw new HTTPError(409, e.message); throw e; }
		});
		r.handle('POST /api/conversations/import', async req => {
			try { return json(200, s.store.importConversation(await body<Transfer>(req, transferBody))); } catch (e) { if (e instanceof TransferError) throw new HTTPError(400, e.message); throw e; }
		});
		r.handle('POST /api/conversations/{id}/stop', (_, p) => json(200, { stopped: s.stop(p.id) }));
		r.handle('GET /api/tasks', (_, __, url) => json(200, s.tasks?.tree(url.searchParams.get('project') ?? '') ?? []));
		r.handle('POST /api/tasks/{id}/stop', (_, p) => {
			try { s.tasks?.stopTask(p.id); } catch (e) { return text(404, (e as Error).message); }
			return json(200, { stopped: true });
		});
		r.handle('POST /api/tasks/{id}/message', async (req, p) => {
			const input = await body<{ text?: unknown }>(req, chatBody).catch(() => ({ text: '' }));
			if (typeof input.text !== 'string' || !input.text.trim()) return text(400, 'invalid message');
			try { await s.tasks?.message(p.id, input.text, s.revoked.signal); } catch (e) { return text(409, (e as Error).message); }
			return json(202, { sent: true });
		});
		r.handle('POST /api/conversations/{id}/decide', async (req, p) => {
			const answer = await body<Answer>(req, 64 << 10).catch(() => undefined);
			if (!answer?.id) return text(400, 'invalid decision');
			try {
				await s.start({ id: p.id, text: '', requestId: newID(), approval: answer, owner: true }, s.revoked.signal);
				return json(202, { started: true });
			} catch (e) { return failure(e); }
		});
		r.handle('GET /api/commands', (_, __, url) => json(200, s.commands.specs(url.searchParams.get('client') ?? '')));
		r.handle('POST /api/commands/complete', async req => json(200, await s.commands.complete(await body<CommandRequest>(req, 256 << 10, ['client', 'conversationId', 'text']), true)));
		r.handle('POST /api/commands/run', async req => {
			const input = await body<CommandRequest>(req, 256 << 10, ['client', 'conversationId', 'text']);
			try { return json(200, await s.commands.run(input, true, req.signal)); } catch (e) { return failure(e, 502); }
		});
		r.handle('POST /api/chat', req => s.chat(req));
		r.handle('GET /api/chat/{id}/stream', (req, p) => {
			const running = s.watch(p.id);
			if (!running) return new Response(null, { status: 204 });
			return follow(req, running, Math.max(Number.parseInt(req.headers.get('Last-Event-ID') ?? '0', 10) || 0, 0));
		});
		r.handle('GET /api/events', req => s.events(req));
		r.handle('POST /api/pairing', req => {
			const code = newID() + newID();
			const now = Date.now();
			// Check again: a request authorized just before a rotation must not mint a code that claims the replacement token.
			if (!bearer(req.headers.get('Authorization'), s.token)) return text(401, 'unauthorized');
			for (const [c, expires] of s.codes) if (now >= expires) s.codes.delete(c);
			s.codes.set(code, now + pairingLifetime);
			return json(200, { code, expiresAt: now + pairingLifetime });
		});
		r.handle('POST /api/pairing/claim', async req => {
			const input = await body<{ code?: unknown }>(req, 1 << 10).catch(() => ({ code: '' }));
			if (typeof input.code !== 'string' || !input.code) return text(400, 'invalid pairing request');
			const expires = s.codes.get(input.code);
			s.codes.delete(input.code);
			if (!expires || Date.now() >= expires) return text(403, 'pairing code is invalid or expired; run mob open again');
			return json(200, { token: s.token });
		});
		r.handle('POST /api/token/rotate', async req => {
			const header = req.headers.get('Authorization');
			try { await s.rotateToken(current => bearer(header, current)); } catch (e) { return failure(e); }
			return new Response(null, { status: 204 });
		});
		return r;
	}

	private chat = async (req: Request) => {
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
	private events(req: Request) {
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
	fetch = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const headers = new Headers({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
		const origin = req.headers.get('Origin') ?? '';
		const host = req.headers.get('Host') ?? url.host;
		if (!allowedOrigin(origin, host) && (!origin || origin !== this.web)) return withHeaders(text(403, 'origin denied'), headers);
		if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin'); }
		if (req.method === 'OPTIONS') {
			headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
			headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			// Chrome asks before a public page may reach a loopback address.
			if (req.headers.get('Access-Control-Request-Private-Network') === 'true') headers.set('Access-Control-Allow-Private-Network', 'true');
			return new Response(null, { status: 204, headers });
		}
		const api = url.pathname.startsWith('/api/');
		if (api) {
			headers.set('Cache-Control', 'no-store');
			if (url.pathname !== '/api/pairing/claim' && !bearer(req.headers.get('Authorization'), this.token)) return withHeaders(text(401, 'unauthorized'), headers);
		}
		// Reject arbitrary Host headers too, preventing DNS rebinding against a local service.
		if (!loopbackHost(host)) return withHeaders(text(403, 'host denied'), headers);
		let response: Response | undefined;
		try {
			response = await this.routes.match(req, url);
			if (!response && !api) response = await this.options.assets?.(url.pathname);
		} catch (e) {
			response = failure(e);
		}
		return withHeaders(response ?? text(404, '404 page not found'), headers);
	};

	private routes = this.router();
}

function withHeaders(response: Response, headers: Headers) {
	for (const [k, v] of headers) if (!response.headers.has(k)) response.headers.set(k, v);
	return response;
}

/** follow streams a turn's events until it ends. A client that leaves ends only its own stream, never the turn. */
function follow(req: Request, running: Running, after: number) {
	return sse({ 'x-vercel-ai-ui-message-stream': 'v1' }, async (send, signal) => {
		await running.follow(after, (seq, e: Event) => send(`id: ${seq}\ndata: ${JSON.stringify(encode(e))}\n\n`), signal);
		if (!signal.aborted) send('data: [DONE]\n\n');
	}, req.signal);
}
