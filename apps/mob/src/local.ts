// The single-user process lifecycle shared by the CLI and the desktop app:
// the service, its token, and the background process mob start manages.
import { closeSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, statSync, watch, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Server, Store, newID, ProviderRegistry, catalogURL, type Plugin } from '@mob/core';
import { openBun } from '@mob/core/sqlite/bun';
import { assets } from './assets';
import type { Environment } from './config';
import { Lock, windows, writeAtomic } from './files';
import { catalogPath, fileCatalog, fileProviders } from './providers';
import { version } from './version';
import { sleep } from '@mob/core/sleep';

export type Connection = { url: string; token: string };

/** plugins are what the host adds to every service it starts. */
export const hostPlugins: ((e: Environment, server: Server) => Plugin[])[] = [];
/** setups run once a service exists, before it serves: sandbox, agents, MCP. */
export const setups: ((e: Environment, server: Server) => void | Promise<void>)[] = [];
/** reloads apply a changed configuration to a running service. */
export const reloads: ((e: Environment, server: Server) => void | Promise<void>)[] = [];

export function credentials(c: Environment): Connection {
	let token = c.token;
	if (!token) token = readFileSync(join(c.dir, 'token'), 'utf8').trim();
	if (token.length < 32) throw new Error('token must contain at least 32 bytes');
	return { url: 'http://' + c.addr, token };
}

const storePath = (c: Environment) => join(c.dir, 'mob.sqlite');

/**
 * openStore opens the database owner-only: it holds chats and plugin
 * credentials, and a data directory chosen with --data-dir may already be
 * readable by others. SQLite gives its journals the database file's mode, so
 * the file exists with mode 0600 before SQLite opens it.
 */
export function openStore(path: string) {
	if (!windows) {
		closeSync(openSync(path, 'a', 0o600));
		for (const file of [path, path + '-wal', path + '-shm']) if (existsSync(file)) chmodSync(file, 0o600);
	}
	return new Store(openBun(path), version).open();
}
const tokenLock = (c: Environment) => { mkdirSync(c.dir, { recursive: true, mode: 0o700 }); return Lock.acquire(join(c.dir, 'token.lock')); };

/** writeToken replaces the token file atomically so readers never see a partial token. */
const writeToken = (dir: string, token: string) => writeAtomic(join(dir, 'token'), token);

export type App = { connection: Connection; server: Server; done: Promise<void>; close: () => Promise<void>; configError: () => string };

/**
 * start runs the service on c.addr. The database lock is taken first, so
 * another live service never has its database marked interrupted.
 */
export async function start(c: Environment, background = false): Promise<App> {
	mkdirSync(c.dir, { recursive: true, mode: 0o700 });
	const database = Lock.tryAcquire(storePath(c) + '.lock');
	if (!database) throw new Error('another Mob service holds ' + storePath(c));
	let store: Store;
	let connection: Connection;
	const unlock = tokenLock(c);
	try {
		store = openStore(storePath(c));
		if (!c.token) {
			const path = join(c.dir, 'token');
			try {
				const fd = openSync(path, 'wx', 0o600);
				writeSync(fd, newID() + newID());
				closeSync(fd);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
				if (!windows) chmodSync(path, 0o600);
			}
		}
		connection = credentials(c);
	} catch (e) {
		database.release();
		throw e;
	} finally {
		unlock.release();
	}
	const catalog = fileCatalog();
	const providers = new ProviderRegistry(fileProviders(c.loader.providersPath), catalog, c.demo);
	providers.driver = c.driver;
	let configError = '', providersError = '';
	let resolveDone!: () => void;
	const done = new Promise<void>(r => { resolveDone = r; });
	const server = new Server({
		store, providers, token: connection.token, version,
		persistToken: c.token ? undefined : token => writeToken(c.dir, token),
		shutdown: background ? resolveDone : undefined,
		configurationError: () => [configError, providersError].filter(Boolean).join('\n'),
		assets: assets(),
	});
	for (const plugins of hostPlugins) server.register(...plugins(c, server));
	server.setToolSteps(c.maxToolSteps);
	server.setWebURL(c.webURL);
	for (const setup of setups) await setup(c, server);
	const [hostname, port] = [c.addr.slice(0, c.addr.lastIndexOf(':')).replace(/^\[|\]$/g, ''), Number(c.addr.slice(c.addr.lastIndexOf(':') + 1))];
	let http;
	try {
		const trace = !!process.env.MOB_TRACE;
		http = Bun.serve({
			hostname, port, idleTimeout: 0,
			fetch: trace ? async req => {
				const response = await server.fetch(req);
				console.error(req.method, new URL(req.url).pathname, response.status);
				return response;
			} : server.fetch,
		});
	} catch (e) {
		await server.close();
		store.close();
		database.release();
		throw e;
	}
	connection.url = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${http.port}`;
	await server.startPlugins().catch(e => console.error(String(e)));
	const stops: (() => void)[] = [];
	const fresh = setInterval(() => void refreshCatalog(catalog), 60 * 60_000);
	void refreshCatalog(catalog);
	stops.push(() => clearInterval(fresh));
	stops.push(watchFile(c.loader.path, () => {
		try {
			const next = c.loader.read(true);
			if (next.dir !== c.dir || next.stateDir !== c.stateDir || next.addr !== c.addr || next.token !== c.token) throw new Error('data_dir, state_dir, addr and token changes require a restart; current configuration retained');
			if (next.demo !== c.demo || next.driver !== c.driver) throw new Error('demo and driver changes require a restart; current configuration retained');
			server.setToolSteps(next.maxToolSteps);
			server.setWebURL(next.webURL);
			for (const reload of reloads) void reload(next, server);
			configError = '';
		} catch (e) {
			configError = (e as Error).message;
			console.error('Configuration reload rejected: ' + configError);
		}
	}));
	stops.push(watchFile(c.loader.providersPath, () => {
		try { providers.reload(); providersError = ''; } catch (e) {
			providersError = (e as Error).message + '; current providers retained';
			console.error('providers.json reload rejected: ' + providersError);
		}
	}));
	let closing: Promise<void> | undefined;
	return {
		connection, server, done, configError: () => [configError, providersError].filter(Boolean).join('\n'),
		close: () => closing ??= (async () => {
			for (const stop of stops) stop();
			await server.close();
			await http.stop(true);
			store.close();
			database.release();
		})(),
	};
}

/** watchFile calls reload shortly after path changes; it watches the directory, so an editor's atomic rename does not lose the watch. */
function watchFile(path: string, reload: () => void): () => void {
	const dir = join(path, '..');
	try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return () => {}; }
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seen = existsSync(path);
	const name = path.slice(dir.length + 1);
	let watcher;
	try {
		watcher = watch(dir, (_, file) => {
			if (file !== name) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				// An absent optional file is fine only before it has ever been loaded.
				if (!existsSync(path) && !seen) return;
				seen = true;
				reload();
			}, 150);
		});
	} catch { return () => {}; }
	return () => { clearTimeout(timer); watcher.close(); };
}

/** refreshCatalog downloads models.dev when Mob's copy is older than a day. */
async function refreshCatalog(catalog: { reload(): void }) {
	const path = catalogPath();
	try { if (Date.now() - statSync(path).mtimeMs < 24 * 3600_000) return; } catch { /* missing */ }
	try {
		const response = await fetch(catalogURL, { headers: { 'User-Agent': 'mob' }, signal: AbortSignal.timeout(60_000) });
		if (response.status !== 200) throw new Error('HTTP ' + response.status);
		const text = await response.text();
		const probe = JSON.parse(text);
		if (!probe || typeof probe !== 'object' || !Object.keys(probe).length) throw new Error('unexpected payload');
		writeAtomic(path, text);
		catalog.reload();
	} catch (e) {
		console.error('Model catalog refresh failed: models.dev: ' + (e as Error).message);
	}
}

export async function reachable(c: Connection) {
	try {
		const r = await fetch(c.url + '/api/config', { headers: { Authorization: 'Bearer ' + c.token }, signal: AbortSignal.timeout(1000) });
		return r.status === 200;
	} catch { return false; }
}

export type RuntimeStatus = { background: boolean; configError: string };

export async function status(c: Environment): Promise<RuntimeStatus> {
	const connection = credentials(c);
	let response: Response;
	try {
		response = await fetch(connection.url + '/api/runtime', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(1000) });
	} catch { throw new Error('Mob is not running'); }
	if (response.status !== 200) throw new Error(`runtime status HTTP ${response.status}`);
	return response.json() as Promise<RuntimeStatus>;
}


/** startBackground runs mob serve --background detached, logging to the state directory. */
export async function startBackground(c: Environment) {
	try {
		const s = await status(c);
		if (s.background) return;
		throw new Error('Mob is running in a foreground/UI process; close that owner, then run mob start');
	} catch (e) {
		if ((e as Error).message.startsWith('Mob is running in')) throw e;
	}
	mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
	const logPath = join(c.stateDir, 'daemon.log');
	const log = openSync(logPath, 'a', 0o600);
	if (!windows) chmodSync(logPath, 0o600);
	const [command, ...prefix] = self();
	const child = spawn(command, [...prefix, 'serve', '--background', ...c.loader.arguments()], { env: c.loader.environ(), stdio: ['ignore', log, log], detached: true, windowsHide: true });
	closeSync(log);
	let exited: string | undefined;
	child.once('exit', code => { exited = String(code); });
	child.unref();
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (exited !== undefined) throw new Error(`background process exited (${exited}); see ${logPath}`);
		try { if ((await status(c)).background) return; } catch { /* not yet */ }
		await sleep(100);
	}
	throw new Error(`background startup timed out; inspect ${logPath} and mob status`);
}

/** self is how to run this mob again: the compiled executable, or bun with this script. */
export function self(): string[] {
	const script = Bun.main;
	return script.startsWith('/$bunfs/') || script.includes('~BUN') || !script.endsWith('.ts') ? [process.execPath] : [process.execPath, script];
}

export async function stopBackground(c: Environment) {
	const s = await status(c);
	if (!s.background) throw new Error('Mob belongs to a foreground/UI process; close that owner to stop it');
	const connection = credentials(c);
	const response = await fetch(connection.url + '/api/runtime/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(10_000) });
	if (response.status !== 202) throw new Error(`stop HTTP ${response.status}`);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try { await status(c); } catch { return; }
		await sleep(100);
	}
	throw new Error('shutdown still in progress; check mob status');
}

async function call(connection: Connection, path: string, want: number) {
	const response = await fetch(connection.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(5000) });
	const text = (await response.text()).slice(0, 1 << 16);
	if (response.status !== want) throw new Error(text.trim() || `${path} HTTP ${response.status}`);
	return text;
}

/**
 * rotateToken replaces the local access token. A running service switches
 * at once; only when no service holds the database is the file rewritten alone.
 */
export async function rotateToken(c: Environment) {
	if (c.token) throw new Error('the access token is supplied through configuration; change it there and restart Mob');
	for (let attempt = 0; attempt < 2; attempt++) {
		let connection: Connection;
		try { connection = credentials(c); } catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
			connection = { url: 'http://' + c.addr, token: '' };
		}
		let code = 0;
		try { code = (await fetch(connection.url + '/api/config', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(2000) })).status; } catch { /* not running */ }
		if (code === 200) { await call(connection, '/api/token/rotate', 204); return; }
		if (code === 401) continue;
		if (code) throw new Error(`Mob at ${connection.url} answered HTTP ${code}`);
		const unlock = tokenLock(c);
		try {
			const database = Lock.tryAcquire(storePath(c) + '.lock');
			if (!database) throw new Error(`Mob is starting or not responding at ${connection.url}; run mob token rotate again`);
			try { writeToken(c.dir, newID() + newID()); } finally { database.release(); }
			return;
		} finally { unlock.release(); }
	}
	throw new Error('the token file does not match the running Mob; restart Mob, then run mob token rotate again');
}

async function pairingCode(c: Environment): Promise<[Connection, string]> {
	const connection = credentials(c);
	if (!await reachable(connection)) throw new Error('Mob is not running; start it with mob start');
	let code = '';
	try { code = JSON.parse(await call(connection, '/api/pairing', 200)).code; } catch (e) { throw e instanceof SyntaxError ? new Error('Mob returned an invalid pairing code') : e; }
	if (!code) throw new Error('Mob returned an invalid pairing code');
	return [connection, code];
}

/** pairingURL signs a browser in to the running service once; the fragment never reaches the server. */
export async function pairingURL(c: Environment) {
	const [connection, code] = await pairingCode(c);
	return connection.url + '/#pair=' + code;
}

/** webURL signs the public web UI in once; the offer travels base64url-encoded in the fragment. */
export async function webURL(c: Environment) {
	if (!c.webURL) throw new Error('web_url is empty in the configuration; set it to use the public web UI');
	const [connection, code] = await pairingCode(c);
	const host = new URL(connection.url).hostname;
	if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`the public web UI reaches Mob only at 127.0.0.1 or localhost, not ${connection.url}`);
	const offer = Buffer.from(JSON.stringify({ v: 1, url: connection.url, code })).toString('base64url');
	return c.webURL.replace(/\/$/, '') + '/#offer=' + offer;
}
