// The hub keeps Mob connected to the configured MCP servers and knows the
// tools each one offers.
import { cell, type Entry, type Tool } from '@mob/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { version } from '../version';
import { catalogKey, curated, fetchRegistry, hostOf, needs, refreshAfter, sameRegistry, type Catalog, type Listing, type Registry } from './catalog';
import { exposure, fingerprint, names, same, serverName, target, type Server, type Servers } from './config';
import { finishSignIn, Grants, signInHint, signInTimeout, SignIn, type Settings, type Waiting } from './oauth';

/** connectTimeout bounds starting a server and listing its tools; callTimeout one tool call. */
const connectTimeout = 30_000, callTimeout = 120_000;
/** maxBackoff is the longest wait before reconnecting to a server. */
const maxBackoff = 5 * 60_000;
/** toolOutput bounds the result the model reads, in bytes. */
const toolOutput = 32 << 10;
/** installedKey keeps the servers the owner approved installing. */
const installedKey = 'mcp_installed';
const installName = 'tool_install';
/** settle is how long an install waits to say whether the server connected or needs a sign-in. */
export let settle = 10_000;
/** retryAfter is how long Mob waits to ask a registry again after it failed. */
export let retryAfter = 3600_000;
export const setTimings = (t: { settle?: number; retryAfter?: number }) => { settle = t.settle ?? settle; retryAfter = t.retryAfter ?? retryAfter; };

const signInPrefix = 'sign in to connect: ';

/** State is one server as Mob last saw it. */
type State = {
	server: Server;
	/** client is unset while the server is not connected. */
	client?: Client;
	/** tools are what the server last listed; they stay known while it reconnects. */
	tools: MCPTool[];
	status: string;
};

/** Installed is a server installed from the catalog. */
type Installed = { listing: Listing; at: string; approvalId: string };
type InstallRequest = { server: string; name: string; title?: string; version?: string; url: string; repository?: string; source: string; description?: string };
type CallRequest = { server: string; tool: string; arguments?: Record<string, unknown>; target: string; config: string };

const installedServer = (i: Installed): Server => ({ url: i.listing.url, oauth: true });

export function oneLine(text: string) {
	text = text.split(/\s+/).filter(Boolean).join(' ');
	return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

const brief = (s: string) => { const c = [...s.trim()]; return c.length > 300 ? c.slice(0, 300).join('') + '…' : s.trim(); };

/**
 * toolName is mcp__<server>__<tool> when that uses only the characters models
 * accept and is at most 64 long. Otherwise it is cut to fit, with those
 * characters replaced, and ends in a hash of the server and tool.
 */
export function toolName(server: string, tool: string) {
	const name = `mcp__${server}__${tool}`;
	const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	if (safe === name && name.length <= 64) return name;
	return safe.slice(0, 47) + '_' + createHash('sha256').update(server + '\0' + tool).digest('hex').slice(0, 16);
}

/** parameters is a tool's input schema as models take it: a JSON object schema, or one that accepts any object. */
const parameters = (schema: unknown) => schema && typeof schema === 'object' && (schema as { type?: unknown }).type === 'object' ? schema as Record<string, unknown> : { type: 'object' };

/** render is what the model reads of a result: its text, other content as JSON, and its structured content when it has no text. */
export function render(result: CallToolResult) {
	const parts = (result.content ?? []).map(c => c.type === 'text' ? c.text : JSON.stringify(c));
	if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
	let output = parts.join('\n');
	const bytes = new TextEncoder().encode(output);
	if (bytes.length > toolOutput) output = new TextDecoder().decode(bytes.slice(0, toolOutput)).replace(/�$/, '') + '\n[truncated]';
	return output;
}

const nameWords = new Set(['mcp', 'www', 'api', 'sse', 'v1', 'com', 'io', 'dev', 'app', 'net', 'org']);

/** localName is the name an installed server's tools carry: words of its URL's host, most significant first, then of its path. */
export function localName(raw: string, servers: Servers) {
	const u = new URL(raw);
	const words = [...u.hostname.toLowerCase().split('.').reverse(), ...u.pathname.toLowerCase().split('/')];
	const parts: string[] = [];
	for (let w of words) {
		w = w.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		if (w && !nameWords.has(w) && !parts.includes(w)) parts.push(w);
	}
	let name = parts.join('-').replace(/^-+|-+$/g, '');
	if (name.length > 28) name = name.slice(0, 28).replace(/^-+|-+$/g, '');
	if (!name) name = 'server';
	let unique = name;
	for (let n = 2; servers[unique]; n++) unique = `${name}-${n}`;
	return unique;
}

/** environment is Mob's environment without its own MOB_* variables, such as the service token. */
function environment(extra: string[] = []) {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('MOB_')) env[k] = v;
	for (const entry of extra) { const i = entry.indexOf('='); env[entry.slice(0, i)] = entry.slice(i + 1); }
	return env;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
	const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
	const t = setTimeout(done, ms);
	signal.addEventListener('abort', done, { once: true });
});

export class Hub {
	readonly grants: Grants;
	/** changed reconnects after an install or removal changed the servers. */
	changed: () => Promise<void> = async () => {};
	private servers: Servers = {};
	private config: Servers = {};
	private states?: Map<string, State>;
	private registry: Registry = { url: '', namespaces: [] };
	private refreshing = false;
	private cached?: Catalog;
	private tried?: Registry;
	private triedAt = 0;
	private installing: Promise<unknown> = Promise.resolve();
	readonly waits = new Map<string, Waiting>();

	constructor(readonly settings?: Settings, readonly fetcher: typeof fetch = fetch) {
		this.grants = new Grants(settings);
	}

	/** configured is the current servers. */
	configured() { return this.servers; }

	/** serve keeps every server in servers connected until signal aborts. */
	async serve(servers: Servers, signal: AbortSignal, status: (s: string) => void) {
		this.states = new Map(Object.entries(servers).map(([name, server]) => [name, { server, tools: [], status: 'connecting' }]));
		const report = () => status(this.status());
		report();
		await Promise.all(Object.entries(servers).map(([name, server]) => this.keep(name, server, signal, report)));
		this.states = undefined;
	}

	/** keep connects to one server, and reconnects with growing pauses whenever the connection fails or ends. */
	private async keep(name: string, server: Server, signal: AbortSignal, report: () => void) {
		let backoff = 5000;
		while (!signal.aborted) {
			let err: unknown;
			try {
				const client = await this.connect(name, server, signal, report);
				backoff = 5000;
				report();
				err = await new Promise<unknown>(resolve => {
					const stop = () => { void client.close(); };
					signal.addEventListener('abort', stop, { once: true });
					client.onclose = () => { signal.removeEventListener('abort', stop); resolve(new Error('connection closed')); };
				});
				this.set(name, s => { s.client = undefined; });
				if (signal.aborted) return;
			} catch (e) { err = e; }
			if (signal.aborted) return;
			this.set(name, s => { s.status = 'reconnecting after: ' + oneLine((err as Error)?.message ?? String(err)); });
			report();
			await sleep(backoff, signal);
			backoff = Math.min(2 * backoff, maxBackoff);
		}
	}

	private newClient(name: string) {
		const client = new Client({ name: 'mob', version });
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			try {
				const tools = await list(client);
				this.set(name, s => { if (s.client === client) s.tools = tools; });
			} catch { /* the last list stays */ }
		});
		return client;
	}

	/** connect starts a session with server and lists its tools. */
	private async connect(name: string, server: Server, signal: AbortSignal, report: () => void): Promise<Client> {
		const opts = { signal, timeout: connectTimeout };
		let client = this.newClient(name);
		if (!server.url) {
			await client.connect(new StdioClientTransport({ command: server.command!, args: server.args, env: environment(server.env), cwd: server.dir || undefined, stderr: 'ignore' }), opts);
		} else {
			const make = (signIn?: SignIn) => new StreamableHTTPClientTransport(new URL(server.url!), { authProvider: signIn, requestInit: { headers: server.headers }, fetch: this.fetcher });
			if (!server.oauth) await client.connect(make(), opts);
			else {
				const signIn = new SignIn(name, server, this.grants, this.waits, link => { this.set(name, s => { s.status = signInPrefix + link; }); report(); });
				signIn.open();
				try {
					for (;;) {
						const transport = make(signIn);
						try { await client.connect(transport, opts); break; } catch (err) {
							if (!(err instanceof UnauthorizedError) || !signIn.pending) throw err;
							// Connecting waits for the user to sign in.
							const code = await signIn.code(AbortSignal.any([signal, AbortSignal.timeout(signInTimeout)]));
							await transport.finishAuth(code);
							signIn.pending = '';
							client = this.newClient(name);
						}
					}
				} finally { signIn.close(); }
			}
		}
		let tools: MCPTool[];
		try { tools = await list(client, opts); } catch (err) { await client.close(); throw err; }
		this.set(name, s => { s.client = client; s.tools = tools; s.status = `${tools.length} tools`; });
		return client;
	}

	/** set changes a server's state while the hub serves it. */
	private set(name: string, change: (s: State) => void) {
		const s = this.states?.get(name);
		if (s) change(s);
	}

	/** status says, for each server, how many tools it offers or why it is not connected. */
	status() {
		return names(this.servers).map(name => `${name}: ${this.states?.get(name)?.status ?? 'not running'}`).join('; ');
	}

	// Tools.

	/**
	 * tools are the tools of every server Mob has connected to. A tool is
	 * offered to the owner's turns while its server is connected, and every
	 * call waits for the owner's approval unless they chose to always allow it.
	 */
	tools(): Tool[] {
		const list: Tool[] = [];
		for (const name of names(this.servers)) {
			const s = this.states?.get(name);
			if (!s) continue;
			for (const tool of s.tools) list.push({ ...this.tool(name, s.server, tool), exposure: exposure(this.servers[name]!, tool.name), namespace: 'MCP server ' + name });
		}
		return list;
	}

	private tool(server: string, config: Server, tool: MCPTool): Tool {
		let description = (tool.description ?? '').trim() || tool.title || '';
		if (description.length > 2000) description = description.slice(0, 2000) + '…';
		return {
			name: toolName(server, tool.name),
			description: `Tool ${tool.name} of the MCP server ${server}, which the user configured; each call waits for the user's approval. ${description}`,
			parameters: parameters(tool.inputSchema),
			ownerOnly: true,
			available: () => !!this.states?.get(server)?.client,
			run: call => call.requestApproval({ server, tool: tool.name, arguments: Object.keys(call.input).length ? call.input : undefined, target: target(config), config: fingerprint(config) } satisfies CallRequest),
			approved: call => this.call(JSON.parse(call.input) as CallRequest, call.signal),
			// Always allowing a tool covers that tool only, on the server as it was configured when it was allowed.
			scope: input => { const r = JSON.parse(input) as CallRequest; return `${JSON.stringify(r.tool)} on ${r.server} (${r.target}, configuration ${r.config})`; },
		};
	}

	/** call runs an approved call on the server it was approved for. */
	private async call(r: CallRequest, signal?: AbortSignal) {
		const config = this.servers[r.server];
		const client = this.states?.get(r.server)?.client;
		if (!config) throw new Error('this MCP server is no longer configured');
		if (fingerprint(config) !== r.config) throw new Error(`the MCP server ${r.server} was reconfigured after this call was approved; ask again`);
		if (!client) throw new Error(`the MCP server ${r.server} is not connected`);
		const result = await client.callTool({ name: r.tool, arguments: r.arguments ?? {} }, undefined, { signal, timeout: callTimeout }) as CallToolResult;
		const output = render(result);
		if (result.isError) throw new Error(output);
		return output;
	}

	// Installs.

	private installs() { return this.settings?.setting<Record<string, Installed>>(installedKey) ?? {}; }

	/**
	 * configure replaces the servers config.yaml lists and reports whether the
	 * servers Mob connects to changed. Installed servers join them under names
	 * config.yaml does not use.
	 */
	configure(servers: Servers) {
		this.config = servers;
		return this.merge(this.installs());
	}

	private merge(installs: Record<string, Installed>) {
		const merged: Servers = { ...this.config };
		for (const [name, i] of Object.entries(installs)) if (!this.shadowed(name, i)) merged[name] = installedServer(i);
		if (same(this.servers, merged)) return false;
		this.servers = merged;
		return true;
	}

	/** shadowed reports whether config.yaml has an install's name or URL. */
	private shadowed(name: string, i: Installed) {
		return name in this.config || Object.values(this.config).some(s => s.url === i.listing.url);
	}

	/** installed reports whether a server came from the catalog and is not shadowed by config.yaml. */
	installed(name: string) { const i = this.installs()[name]; return !!i && !this.shadowed(name, i); }

	/** shadowedInstalls are the installs config.yaml has taken the name or URL of. */
	shadowedInstalls() { return Object.entries(this.installs()).filter(([n, i]) => this.shadowed(n, i)).map(([n]) => n).sort(); }

	private serialize<T>(fn: () => T | Promise<T>): Promise<T> {
		const next = this.installing.then(fn, fn);
		this.installing = next.catch(() => {});
		return next;
	}

	/** install keeps a server the owner approved and connects to it; it returns why reconnecting failed, if it did. */
	async install(r: InstallRequest, approvalId: string): Promise<string> {
		if (!this.settings) throw new Error('installed servers cannot be kept');
		const installs = await this.serialize(() => {
			const installs = this.installs();
			if (installs[r.server]) throw new Error(`a server named ${r.server} is installed already`);
			installs[r.server] = { listing: { name: r.name, title: r.title, description: r.description ?? '', version: r.version, repository: r.repository, url: r.url, source: r.source }, at: new Date().toISOString(), approvalId };
			this.settings!.saveSetting(installedKey, installs);
			return installs;
		});
		try { await this.apply(installs); return ''; } catch (err) { return 'installed, but reconnecting failed: ' + (err as Error).message; }
	}

	/** remove forgets an installed server, and its sign-in unless config.yaml has a server of that name. */
	async remove(name: string) {
		const installs = await this.serialize(() => {
			const installs = this.installs();
			if (!installs[name]) throw new Error(`${name} is not an installed server`);
			delete installs[name];
			this.settings!.saveSetting(installedKey, installs);
			return installs;
		});
		if (!(name in this.config)) this.grants.save(name);
		await this.apply(installs);
	}

	private async apply(installs: Record<string, Installed>) {
		if (this.merge(installs)) await this.changed();
	}

	/** installTool asks the owner to install a server from the catalog, while the catalog has servers to install. */
	installTool(): Tool {
		return {
			name: installName,
			description: 'Ask the owner to install a remote MCP server that tool_search found, by its URL. Stops the turn until the owner decides; once installed and connected, its tools are found with tool_search.',
			parameters: { type: 'object', properties: { url: { type: 'string', description: "The server's URL, as tool_search gave it" } }, required: ['url'], additionalProperties: false },
			ownerOnly: true,
			available: () => this.listings().length > 0,
			run: async call => {
				const l = this.listing(String(call.input.url ?? ''));
				if (!l) throw new Error('no server in the catalog has that URL; find one with tool_search');
				const header = needs(l);
				if (header) throw new Error(`this server needs the ${header} header; the owner adds it under mcp_servers in config.yaml`);
				return call.requestApproval({ server: localName(l.url, this.servers), name: l.name, title: l.title, version: l.version, url: l.url, repository: l.repository, source: l.source, description: brief(l.description) } satisfies InstallRequest);
			},
			approved: async call => {
				const r = JSON.parse(call.input) as InstallRequest;
				// The catalog may have dropped the server while the owner decided.
				const l = this.listing(r.url);
				if (!l || needs(l)) throw new Error('the catalog no longer offers this server; find one with tool_search');
				if (this.servers[r.server] || !serverName.test(r.server)) throw new Error(`the name ${r.server} is taken now; ask again`);
				const failed = await this.install(r, call.approvalId);
				return { installed: r.server, status: failed || await this.await(r.server, call.signal) };
			},
			// Remembering an install covers installing the same server again.
			scope: input => (JSON.parse(input) as InstallRequest).url,
		};
	}

	/** await waits a little for a new server to connect or to ask the owner to sign in, and says which. */
	private async await(name: string, signal?: AbortSignal) {
		const deadline = Date.now() + settle;
		for (;;) {
			const status = this.states?.get(name)?.status ?? 'connecting';
			if (status.startsWith(signInPrefix)) return `The owner must sign in before its tools can be used: ${status.slice(signInPrefix.length)} Give them the link and say: ${signInHint}`;
			if (status.endsWith(' tools') || Date.now() > deadline) return status + '; its tools are found with tool_search';
			if (signal?.aborted) return status;
			await Bun.sleep(200);
		}
	}

	// Catalog.

	/** configureRegistry sets where the catalog looks; a change asks the registry again when the catalog is next read. */
	configureRegistry(r: Registry) { this.registry = r; }

	private listed(): Catalog {
		this.cached ??= this.settings?.setting<Catalog>(catalogKey) ?? { registry: { url: '', namespaces: [] }, synced: '', listings: [] };
		return this.cached;
	}

	/** listings are the servers the model may install: Mob's own, then the registry's, without any configured or installed already. */
	listings(): Listing[] {
		const registry = this.registry, cached = this.listed();
		const asked = registry.namespaces.length > 0;
		const current = asked && sameRegistry(cached.registry, registry);
		if (asked && (!current || Date.now() - Date.parse(cached.synced || '0') > refreshAfter)) this.refresh(registry);
		const taken = new Set(Object.values(this.servers).map(s => s.url).filter(Boolean));
		const list: Listing[] = [];
		for (const l of [...curated, ...current ? cached.listings : []]) {
			if (taken.has(l.url)) continue;
			taken.add(l.url);
			list.push(l);
		}
		return list;
	}

	private listing(url: string) { return this.listings().find(l => l.url === url); }

	/** refresh asks the registry in the background, once at a time; after a failure it waits retryAfter before asking the same registry. */
	private refresh(r: Registry) {
		if (this.refreshing || (this.tried && sameRegistry(this.tried, r) && Date.now() - this.triedAt < retryAfter)) return;
		this.refreshing = true; this.tried = r; this.triedAt = Date.now();
		void fetchRegistry(r, AbortSignal.timeout(120_000), this.fetcher).then(listings => {
			this.cached = { registry: r, synced: new Date().toISOString(), listings };
			this.settings?.saveSetting(catalogKey, this.cached);
		}, () => { /* what was listed before stays */ }).finally(() => { this.refreshing = false; });
	}

	/** entries are the servers the catalog offers, for tool_search to find. */
	entries(): Entry[] {
		return this.listings().map(l => {
			const host = hostOf(l.url);
			const header = needs(l);
			return {
				kind: 'MCP server',
				name: l.name.includes(host) ? l.name : `${l.name} (${host})`,
				description: [l.title ?? '', l.description].join('. ').trim() + ' ' + l.url,
				use: header ? `Not installed. It needs the ${header} header, so the owner adds it under mcp_servers in config.yaml with url ${JSON.stringify(l.url)}.`
					: `Not installed. To use it, call tool_install with url ${JSON.stringify(l.url)}; the owner approves the install.`,
				ownerOnly: true,
			};
		});
	}

	/** finishSignIn completes a sign-in pasted from another device. */
	finishSignIn(address: string) { return finishSignIn(this.waits, address); }

	/** describe is a table of the servers and the tools they offer. */
	describe() {
		const shadowed = this.shadowedInstalls();
		if (!Object.keys(this.servers).length) return 'No MCP servers are configured. Add them under `mcp_servers` in config.yaml, or let the model install one with tool_install.';
		let b = '| Server | Status | Tools |\n| --- | --- | --- |\n';
		for (const name of names(this.servers)) {
			let status = 'not running';
			const tools: string[] = [];
			const s = this.states?.get(name);
			if (s) {
				status = s.status;
				if (!s.client && s.tools.length) status += ' (tools unavailable until it reconnects)';
				for (const t of s.tools) {
					const e = exposure(this.servers[name]!, t.name);
					tools.push('`' + toolName(name, t.name) + '`' + (e !== 'deferred' ? ` (${e})` : ''));
				}
			}
			b += `| ${cell(name in this.config ? name : name + ' (installed)')} | ${cell(status)} | ${tools.join(' ')} |\n`;
		}
		if (shadowed.length) b += `\nconfig.yaml has the name or URL of installed ${shadowed.join(', ')}, so the configured server is used; \`/mcp remove NAME\` forgets the install.\n`;
		if (b.includes(signInPrefix)) b += '\n' + signInHint;
		return b + "\nThe model loads a server's tools with tool_search when a task needs them, unless `exposure` says otherwise. Each call waits for your approval; **Always allow** stops asking for that tool on that server.";
	}
}

async function list(client: Client, opts?: { signal?: AbortSignal; timeout?: number }) {
	const tools: MCPTool[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined, opts);
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}
