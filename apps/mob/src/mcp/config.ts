// How Mob reaches MCP servers, as mcp_servers in config.yaml lists them.
import { parseExposure, type Exposure } from '@mob/core';
import { createHash } from 'node:crypto';

/**
 * Server is how Mob reaches one MCP server: a command it starts and talks to
 * over stdin and stdout, or the URL of a Streamable HTTP endpoint.
 */
export type Server = {
	command?: string;
	args?: string[];
	/** env adds KEY=VALUE entries to the environment the command inherits from Mob, which leaves out Mob's own MOB_* variables. */
	env?: string[];
	/** dir is the command's working directory; empty is Mob's. */
	dir?: string;
	url?: string;
	/** headers are sent with every request to url, such as Authorization. */
	headers?: Record<string, string>;
	/** oauth signs in to url with OAuth when the server asks: the user opens a link Mob shows, and Mob keeps the token. */
	oauth?: boolean;
	/** exposure is how the server's tools reach the model: deferred, the default, until tool_search loads them; direct; or hidden. */
	exposure?: string;
	/** toolExposure sets the exposure of the tools whose names match a glob over exposure; an exact name wins, then a longer glob. */
	toolExposure?: Record<string, string>;
};

export type Servers = Record<string, Server>;

/**
 * serverName is what a server may be called: its tools are named
 * mcp__<server>__<tool>, and models accept only these characters. A name
 * neither contains __ nor begins or ends with _, so the first __ after the
 * prefix always ends the server's name.
 */
export const serverName = /^[a-z0-9-]+(_[a-z0-9-]+)*$/;

const keys: Record<string, keyof Server> = { command: 'command', args: 'args', env: 'env', dir: 'dir', url: 'url', headers: 'headers', oauth: 'oauth', exposure: 'exposure', tool_exposure: 'toolExposure' };

/** decode reads mcp_servers as config.yaml writes it, refusing what it does not know. */
export function decode(raw: Record<string, Record<string, unknown>>): Servers {
	const servers: Servers = {};
	for (const [name, fields] of Object.entries(raw ?? {})) {
		const fail = (message: string): never => { throw new Error(`mcp_servers.${name}: ${message}`); };
		if (!fields || typeof fields !== 'object' || Array.isArray(fields)) fail('must be a map');
		const s: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(fields)) {
			const field = keys[key] ?? fail(`unknown field ${key}`);
			const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
			const map = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');
			const ok = field === 'args' || field === 'env' ? strings(value) : field === 'headers' || field === 'toolExposure' ? map(value) : field === 'oauth' ? typeof value === 'boolean' : typeof value === 'string';
			if (!ok) fail(`${key} has the wrong type`);
			s[field] = value;
		}
		servers[name] = s as Server;
	}
	return servers;
}

/** glob matches name as Go's path.Match does; an invalid pattern throws. */
export function glob(pattern: string, name: string) {
	let re = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === '*') re += '[^/]*';
		else if (c === '?') re += '[^/]';
		else if (c === '\\') { if (++i >= pattern.length) throw new Error('bad pattern'); re += '\\' + pattern[i]; }
		else if (c === '[') {
			let j = i + 1, cls = '';
			if (pattern[j] === '^') { cls = '^'; j++; }
			const from = cls.length;
			for (; j < pattern.length && pattern[j] !== ']'; j++) {
				const ch = pattern[j]!;
				if (ch === '\\') { if (++j >= pattern.length) throw new Error('bad pattern'); cls += '\\' + pattern[j]; }
				else cls += ch === '[' || ch === '^' ? '\\' + ch : ch;
			}
			if (j >= pattern.length || cls.length === from) throw new Error('bad pattern');
			re += `[${cls}]`;
			i = j;
		} else re += c.replace(/[.+^${}()|\]\\/]/g, '\\$&');
	}
	return new RegExp(`^${re}$`).test(name);
}

/** validate refuses a server that names neither or both of a command and a URL, or that cannot be told apart in tool names. */
export function validate(servers: Servers) {
	for (const name of names(servers)) {
		const s = servers[name]!;
		const fail = (message: string): never => { throw new Error(`mcp_servers.${name}: ${message}`); };
		if (name.length > 32 || !serverName.test(name)) fail('names use a-z, 0-9, - and single _ between them, up to 32 characters');
		if (s.exposure) try { parseExposure(s.exposure); } catch (err) { fail((err as Error).message); }
		for (const [pattern, exposure] of Object.entries(s.toolExposure ?? {})) {
			try { glob(pattern, ''); } catch { fail(`tool_exposure ${JSON.stringify(pattern)} is not a valid glob`); }
			try { parseExposure(exposure); } catch (err) { fail(`tool_exposure ${JSON.stringify(pattern)}: ${(err as Error).message}`); }
		}
		if (!s.command === !s.url) fail('set either command or url');
		if (s.url) {
			let u: URL | undefined;
			try { u = new URL(s.url); } catch { /* refused below */ }
			if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || !u.host) fail('url must be an http or https URL');
			if (s.args?.length || s.env?.length || s.dir) fail('args, env and dir are for a command');
			if (s.oauth && Object.keys(s.headers ?? {}).some(k => k.toLowerCase() === 'authorization')) fail('oauth sets the Authorization header itself');
		} else {
			if (Object.keys(s.headers ?? {}).length || s.oauth) fail('headers and oauth are for a url');
			for (const entry of s.env ?? []) if (entry.indexOf('=') <= 0) fail('env entries are KEY=VALUE');
		}
	}
}

/** names are the servers in order. */
export const names = (servers: Servers) => Object.keys(servers).sort();

/** exposure is how the server's tool reaches the model. */
export function exposure(s: Server, tool: string): Exposure {
	let best = -1, chosen = '', value = s.exposure ?? '';
	for (const [pattern, e] of Object.entries(s.toolExposure ?? {})) {
		const weight = pattern === tool ? Number.MAX_SAFE_INTEGER : pattern.length;
		let ok = false;
		try { ok = glob(pattern, tool); } catch { /* validated */ }
		// Equal globs are told apart by their text, so the choice is stable.
		if (ok && (weight > best || (weight === best && pattern < chosen))) { best = weight; chosen = pattern; value = e; }
	}
	try { return parseExposure(value); } catch { return 'deferred'; }
}

/** target is what an approval shows the server as: its URL, or its command and each argument quoted. */
export const target = (s: Server) => s.url ? s.url : [s.command!, ...s.args ?? []].map(w => JSON.stringify(w)).join(' ');

/**
 * fingerprint identifies the whole configuration of a server, its
 * environment, directory and headers included, without showing their values.
 * An approved call runs only while the fingerprint is unchanged, so a server
 * switched to another account or program asks again.
 */
export function fingerprint(s: Server) {
	const sorted = (m?: Record<string, string>) => m && Object.keys(m).length ? Object.fromEntries(Object.entries(m).sort(([a], [b]) => a < b ? -1 : 1)) : null;
	// Go's encoding/json field order, so approvals given before the TypeScript host still hold.
	const canonical: Record<string, unknown> = { Command: s.command ?? '', Dir: s.dir ?? '', URL: s.url ?? '', Args: s.args?.length ? s.args : null, Env: s.env?.length ? s.env : null, Headers: sorted(s.headers) };
	if (s.oauth) canonical.OAuth = true;
	return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24);
}

/** same reports whether two server lists are alike. */
export const same = (a: Servers | undefined, b: Servers | undefined) => JSON.stringify(sortDeep(a ?? {})) === JSON.stringify(sortDeep(b ?? {}));

function sortDeep(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortDeep);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, sortDeep(x)]));
	return v;
}
