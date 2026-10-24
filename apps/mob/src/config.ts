// Runtime configuration: explicit CLI flags > nonempty MOB_ environment
// variables > the configuration file (YAML or JSON) > defaults.
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { webOrigin } from '@mob/core/app/server';
import { windows } from './files';
import { configHome, dataHome, stateHome } from './paths';

export const maxToolSteps = 100, defaultToolSteps = 20;
export const defaultWebURL = 'https://usemob.app';
export const defaultRegistry = 'https://registry.modelcontextprotocol.io';
export const defaultImage = 'python:3.13-slim';

type Value = string | boolean | number;
type Option = { key: string; value: Value | (() => Value); help: string; defaultText?: string; secret?: boolean };

/** defaultDataDir reuses an existing pre-XDG database; history is never silently moved or abandoned. */
function defaultDataDir() {
	const old = join(windows ? process.env.APPDATA ?? '' : process.platform === 'darwin' ? join(process.env.HOME ?? '', 'Library', 'Application Support') : configHome(), 'mob');
	return existsSync(join(old, 'mob.sqlite')) ? old : join(dataHome(), 'mob');
}

/** options owns defaults, CLI flags, environment bindings and reference documentation. */
export const options: Option[] = [
	{ key: 'config', value: '', help: 'Configuration file path (selector only; not a file field)', defaultText: 'XDG config home/mob/config.yaml' },
	{ key: 'data_dir', value: defaultDataDir, help: 'SQLite, token and conversation workspaces; restart required', defaultText: 'XDG data home/mob (existing legacy database reused)' },
	{ key: 'state_dir', value: () => join(stateHome(), 'mob'), help: 'Background logs; restart required', defaultText: 'XDG state home/mob' },
	{ key: 'addr', value: '127.0.0.1:8787', help: 'Local service loopback IP and port; restart required' },
	{ key: 'demo', value: false, help: 'Use offline model simulation; restart required' },
	{ key: 'max_tool_steps', value: defaultToolSteps, help: 'Model calls per turn (1-100)' },
	{ key: 'web_url', value: defaultWebURL, help: 'Public web UI URL; an empty flag or file value disables it' },
	{ key: 'token', value: '', help: 'Local access token (at least 32 bytes); empty uses the managed token file; restart required', secret: true },
	{ key: 'sandbox.enabled', value: false, help: 'Expose the container sandbox tool' },
	{ key: 'sandbox.runtime', value: '', help: 'Container runtime: containerd, apple or wslc; empty selects by platform' },
	{ key: 'sandbox.image', value: defaultImage, help: 'Container image for commands' },
	{ key: 'sandbox.network', value: '', help: 'Container network; none disables it, empty uses runtime default' },
	{ key: 'sandbox.cpus', value: 0, help: 'Nonnegative CPU limit; zero uses runtime default' },
	{ key: 'sandbox.memory', value: '', help: 'Memory limit with unit, at least 64m; empty uses runtime default' },
	{ key: 'sandbox.isolation', value: '', help: 'gvisor requires containerd; empty uses runtime default' },
	{ key: 'mcp_servers', value: '{}', help: 'MCP server map; JSON object in flags/environment, native map in files', secret: true },
	{ key: 'mcp_registry.url', value: defaultRegistry, help: 'MCP registry the model searches for remote servers to install' },
	{ key: 'mcp_registry.namespaces', value: '', help: "Comma-separated registry name globs, such as com.cloudflare.mcp/*, the model may install from; empty offers only Mob's own list" },
];

export const flagOf = (o: Option) => o.key.replace(/[._]/g, '-');
export const envOf = (o: Option) => 'MOB_' + o.key.replaceAll('.', '_').toUpperCase();
const defaultOf = (o: Option) => (typeof o.value === 'function' ? o.value() : o.value);

export type SandboxSettings = { enabled: boolean; runtime: string; image: string; network: string; cpus: number; memory: string; isolation: string };
export type MCPServers = Record<string, Record<string, unknown>>;

export type Environment = {
	dir: string;
	stateDir: string;
	addr: string;
	token: string;
	demo: boolean;
	sandbox: SandboxSettings;
	maxToolSteps: number;
	mcpServers: MCPServers;
	mcpRegistry: { url: string; namespaces: string[] };
	webURL: string;
	loader: Loader;
};

/** Validators check sections owned by other modules (sandbox, MCP) once they load. */
export const validators: ((e: Environment) => void)[] = [];

const fail = (message: string): never => { throw new Error(message); };

/** Loader holds the startup flags; each read takes the file and environment afresh. */
export class Loader {
	readonly path: string;
	private required: boolean;

	/** flags are the options given explicitly on the command line, by key. */
	constructor(private flags: Record<string, Value> = {}) {
		const selector = flags.config ?? (process.env.MOB_CONFIG || '');
		this.required = selector !== '';
		this.path = resolve(String(selector) || join(configHome(), 'mob', 'config.yaml'));
	}

	/** providersPath is providers.json, beside the configuration file. */
	get providersPath() { return join(resolve(this.path, '..'), 'providers.json'); }

	/** arguments forwards the explicit flags to a background service, secrets excepted. */
	arguments(): string[] {
		return options.filter(o => o.key in this.flags && !(o.secret && this.flags[o.key] !== '')).map(o => `--${flagOf(o)}=${this.flags[o.key]}`);
	}

	/** environ forwards secret flags to the daemon without copying them into its argv. */
	environ(): Record<string, string> {
		const env: Record<string, string> = { ...process.env as Record<string, string> };
		for (const o of options) if (o.secret && o.key in this.flags) env[envOf(o)] = String(this.flags[o.key]);
		return env;
	}

	read(required = this.required): Environment {
		let file: Record<string, unknown> = {};
		let mode = 0;
		const raw = readConfigFile(this.path);
		if (raw === undefined) {
			if (required) fail('cannot safely read configuration file');
		} else {
			mode = raw.mode;
			const format = extname(this.path).toLowerCase();
			let parsed: unknown;
			try {
				parsed = format === '.json' ? JSON.parse(raw.text) : format === '.yaml' || format === '.yml' ? Bun.YAML.parse(raw.text) : fail('configuration must be YAML or JSON');
			} catch (e) {
				if ((e as Error).message === 'configuration must be YAML or JSON') throw e;
				fail('invalid configuration syntax (contents omitted)');
			}
			if (parsed !== null && parsed !== undefined && (typeof parsed !== 'object' || Array.isArray(parsed))) fail('invalid configuration syntax (contents omitted)');
			file = (parsed ?? {}) as Record<string, unknown>;
			if (!windows && mode & 0o022) fail('configuration must not be writable by group or others');
		}
		if ('config' in file) fail('config is a file selector, not a configuration field');
		if ('gateway' in file) fail('the experimental gateway was removed; delete the gateway section (remote access uses mob runner)');
		const values: Record<string, unknown> = {};
		const known = new Set(options.map(o => o.key));
		const flat = (obj: Record<string, unknown>, prefix = '') => {
			for (const [k, v] of Object.entries(obj)) {
				const key = prefix + k;
				if (key === 'mcp_servers') { values[key] = v; continue; }
				if (v && typeof v === 'object' && !Array.isArray(v) && [...known].some(o => o.startsWith(key + '.'))) flat(v as Record<string, unknown>, key + '.');
				else if (known.has(key)) values[key] = v;
				else fail('invalid configuration fields or types (contents omitted); model providers live in providers.json');
			}
		};
		flat(file);
		const value = (o: Option): unknown => {
			if (o.key in this.flags) return this.flags[o.key];
			const env = process.env[envOf(o)];
			if (env) return env;
			return o.key in values ? values[o.key] : defaultOf(o);
		};
		const get: Record<string, unknown> = {};
		for (const o of options) {
			if (o.key === 'config') continue;
			let v = value(o);
			const want = typeof defaultOf(o);
			if (o.key === 'mcp_servers') {
				if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
				if (!v || typeof v !== 'object' || Array.isArray(v)) fail('mcp_servers must be a JSON object (contents omitted)');
			} else if (want === 'boolean' && typeof v === 'string') {
				v = ['1', 'true', 't', 'yes'].includes(v.toLowerCase()) ? true : ['0', 'false', 'f', 'no', ''].includes(v.toLowerCase()) ? false : fail('invalid configuration fields or types (contents omitted); model providers live in providers.json');
			} else if (want === 'number' && typeof v === 'string') {
				v = /^-?\d+$/.test(v) ? Number(v) : fail('invalid configuration fields or types (contents omitted); model providers live in providers.json');
			} else if (want === 'string' && typeof v === 'number') v = String(v);
			if (o.key !== 'mcp_servers' && typeof v !== want) fail('invalid configuration fields or types (contents omitted); model providers live in providers.json');
			get[o.key] = v;
		}
		const addr = String(get.addr);
		const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(addr);
		if (!m) fail('addr must be a loopback IP and port');
		const host = m![1] ?? m![2], port = Number(m![3]);
		if (!(host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)) || port < 0 || port > 65535) fail('addr must be a loopback IP and valid port');
		if (!get.data_dir || !get.state_dir) fail('data_dir and state_dir must not be empty');
		const steps = get.max_tool_steps as number;
		if (!Number.isInteger(steps) || steps < 1 || steps > maxToolSteps) fail(`max_tool_steps must be 1 to ${maxToolSteps}`);
		const token = String(get.token);
		if (token && token.length < 32) fail('token must contain at least 32 bytes');
		if (mode && !windows && mode & 0o077 && 'token' in values) fail('configuration with tokens must be owner-only (chmod 600)');
		webOrigin(String(get.web_url));
		const e: Environment = {
			dir: resolve(String(get.data_dir)), stateDir: resolve(String(get.state_dir)), addr, token, demo: get.demo as boolean,
			sandbox: { enabled: get['sandbox.enabled'] as boolean, runtime: get['sandbox.runtime'] as string, image: get['sandbox.image'] as string, network: get['sandbox.network'] as string, cpus: get['sandbox.cpus'] as number, memory: get['sandbox.memory'] as string, isolation: get['sandbox.isolation'] as string },
			maxToolSteps: steps, mcpServers: get.mcp_servers as MCPServers,
			mcpRegistry: { url: get['mcp_registry.url'] as string, namespaces: String(get['mcp_registry.namespaces']).split(',').map(s => s.trim()).filter(Boolean) },
			webURL: String(get.web_url), loader: this,
		};
		for (const validate of validators) validate(e);
		return e;
	}
}

/** readConfigFile reads a regular file of at most 64 KiB, or undefined when it does not exist. */
function readConfigFile(path: string): { text: string; mode: number } | undefined {
	let info;
	try { info = lstatSync(path); } catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		fail('cannot safely read configuration file');
	}
	if (!info!.isFile() || info!.size > 64 << 10) fail('configuration must be a regular file of at most 64 KiB');
	const text = readFileSync(path, 'utf8');
	const after = statSync(path);
	if (after.size !== info!.size || after.mtimeMs !== info!.mtimeMs) fail('configuration changed while reading');
	return { text, mode: after.mode & 0o777 };
}

/** reference documents every option; it never contains current values. */
export function reference() {
	let b = `# Environment variables and configuration

Generated from apps/mob/src/config.ts; run bun run --cwd apps/mob configdocs.

Explicit CLI flags > nonempty MOB_ environment variables > configuration file > defaults.
Empty environment values are ignored consistently; use a flag or file value to clear a string.
There is no .env loader. Restart after changing the process environment.

Keys map to flags by replacing dots/underscores with hyphens, and to environment
variables by replacing dots with underscores, uppercasing and prefixing MOB_.
The config selector chooses the file before loading it and cannot appear inside that file.
The file is YAML (config.yaml) or JSON (config.json).

| File key | CLI flag | Environment | Default | Purpose |
| --- | --- | --- | --- | --- |
`;
	for (const o of options) {
		let value = o.defaultText ?? String(typeof o.value === 'function' ? '' : o.value);
		if (value === '') value = '""';
		b += `| \`${o.key}\` | \`--${flagOf(o)}\` | \`${envOf(o)}\` | \`${value}\` | ${o.help}${o.secret ? '; sensitive: prefer a protected file or environment over argv' : ''} |\n`;
	}
	return b + `
This reference covers runtime configuration. Provider keys and plugin settings
use their own stores; command actions such as open --print are not settings.
XDG_* directory conventions and CI/build variables belong to their respective tools.

See [Configuration](features/configuration.md) for file safety, reload behavior
and migration; [Sandbox](features/sandbox.md) and [MCP](features/mcp.md) describe
their execution and environment boundaries.
`;
}
