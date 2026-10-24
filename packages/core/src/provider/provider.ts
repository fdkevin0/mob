// Model vendors: where each lives, which protocols it speaks, the key the
// user entered, and which of its models they picked. Everything is in
// providers.json beside config.yaml; keys are never read from the environment.
import { parseRef, type Cost } from '../llm/llm';
import { demoID } from '../llm/demo';
import { findPreset } from './presets';

export type Protocol = 'chat' | 'anthropic';

/** ModelPref overrides what the catalog says of one model; api picks the protocol for a vendor serving several. */
export type ModelPref = { name?: string; context?: number; output?: number; reasoning?: boolean; tools?: boolean; vision?: boolean; efforts?: string[]; cost?: Cost; api?: Protocol };

export type Provider = {
	id: string;
	name?: string;
	preset?: string;
	key?: string;
	/** Base URLs, one per protocol the vendor serves; empty takes the preset's. */
	chat?: string;
	anthropic?: string;
	/** modelsURL is where the vendor lists its models, when not at the chat base. */
	modelsURL?: string;
	/** models are the user's picks; none means every model the vendor lists. */
	models?: string[];
	/** pickedFrom is what the vendor listed when models were saved: picks that held all of it take in models listed since. */
	pickedFrom?: string[];
	modelPrefs?: Record<string, ModelPref>;
	headers?: Record<string, string>;
	off?: boolean;
};

/** ProvidersFile is providers.json. default is the model a conversation uses until /model picks another. */
export type ProvidersFile = { default?: string; providers: Provider[] };

/** initialProviders is the zero-configuration file: the offline demo model, until a provider is added. */
export function initialProviders(): ProvidersFile {
	return { default: 'demo/echo', providers: [] };
}

/** endpoint is the provider's base URL for a protocol, its own or its preset's. */
export function endpoint(p: Provider, proto: Protocol): string {
	const preset = findPreset(p.preset);
	return (proto === 'anthropic' ? p.anthropic || preset?.anthropic : p.chat || preset?.chat) ?? '';
}

/** destination is where requests and their credentials go; a key saved for one must not follow a provider to another. */
export const destination = (p: Provider) => [p.preset ?? '', endpoint(p, 'chat'), endpoint(p, 'anthropic'), p.modelsURL ?? ''].join('\x00');

export const displayName = (p: Provider) => p.name || findPreset(p.preset)?.name || p.id;

/** maskedKey shows enough of a key to recognize it. */
export function maskedKey(p: Provider) {
	const k = p.key ?? '';
	if (!k) return '';
	return k.length <= 8 ? '••••' : k.slice(0, 3) + '…' + k.slice(-4);
}

/** publicProvider is the provider with its key and header values withheld. */
export function publicProvider(p: Provider): Provider {
	const out: Provider = { ...p };
	const key = maskedKey(p);
	if (key) out.key = key; else delete out.key;
	if (p.headers && Object.keys(p.headers).length) out.headers = Object.fromEntries(Object.keys(p.headers).map(k => [k, '••••']));
	return out;
}

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const loopback = (host: string) => host === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]' || host === '::1';

/** validateURL accepts HTTPS, and HTTP only for loopback servers. */
export function validateURL(raw: string) {
	let u: URL;
	try { u = new URL(raw); } catch { throw new Error('must be an HTTP(S) API base URL without credentials, query or fragment'); }
	if (!u.host || u.username || u.password || u.search || u.hash || raw.includes('#') || raw.includes('?')) throw new Error('must be an HTTP(S) API base URL without credentials, query or fragment');
	if (u.protocol === 'https:') return;
	if (u.protocol === 'http:' && loopback(u.hostname)) return;
	throw new Error('requires HTTPS except for localhost servers');
}

const printable = (s: string, max: number) => s.length <= max && !/[^\x21-\x7e]/.test(s);

export function validateProvider(p: Provider) {
	const fail = (message: string) => new Error(`provider "${p.id}": ${message}`);
	if (!idPattern.test(p.id ?? '') || p.id === demoID) throw new Error(`provider ID "${p.id}" must be lowercase letters, digits, '.', '_' or '-' (and not "${demoID}")`);
	if (p.preset && !findPreset(p.preset)) throw fail(`unknown preset "${p.preset}"`);
	if (!printable(p.key ?? '', 4096)) throw fail('key must be printable ASCII without spaces');
	if ((p.name ?? '').length > 100 || /[\r\n\0]/.test(p.name ?? '')) throw fail('invalid name');
	for (const u of [p.chat, p.anthropic, p.modelsURL]) {
		if (u) { try { validateURL(u); } catch (e) { throw fail('URL ' + (e as Error).message); } }
	}
	if (!endpoint(p, 'chat') && !endpoint(p, 'anthropic')) throw fail('needs a chat or anthropic base URL');
	for (const m of [...(p.models ?? []), ...(p.pickedFrom ?? [])]) {
		if (!m || m.length > 256 || /[\r\n\0 ]/.test(m)) throw fail(`invalid model ID "${m}"`);
	}
	for (const [m, pref] of Object.entries(p.modelPrefs ?? {})) {
		if (!m || m.length > 256 || (pref.api && pref.api !== 'chat' && pref.api !== 'anthropic')) throw fail(`invalid model preference for "${m}"`);
	}
	for (const [k, v] of Object.entries(p.headers ?? {})) {
		if (!k || !printable(k, 256) || /[\r\n\0]/.test(v) || v.length > 4096) throw fail(`invalid header "${k}"`);
	}
}

const providerKeys = new Set(['id', 'name', 'preset', 'key', 'chat', 'anthropic', 'modelsURL', 'models', 'pickedFrom', 'modelPrefs', 'headers', 'off']);

export function validateProviders(f: ProvidersFile) {
	if (!f || typeof f !== 'object' || !Array.isArray(f.providers) || Object.keys(f).some(k => k !== 'default' && k !== 'providers')) throw new Error('invalid JSON or unknown field');
	const seen = new Set<string>();
	for (const p of f.providers) {
		if (!p || typeof p !== 'object' || Object.keys(p).some(k => !providerKeys.has(k))) throw new Error('invalid JSON or unknown field');
		validateProvider(p);
		if (seen.has(p.id)) throw new Error(`provider "${p.id}" is listed twice`);
		seen.add(p.id);
	}
	if (f.default && !parseRef(f.default)) throw new Error(`default "${f.default}" must be provider/model`);
}

/** picks are the models a provider offers: every one listed when the user picked none; otherwise the picks, plus models listed since when the picks held everything listed at the time. */
export function picks(p: Provider, listed: string[]): string[] {
	if (!p.models?.length) return [...listed];
	const out = [...p.models];
	const from = p.pickedFrom ?? [];
	if (!from.length || !from.every(v => p.models!.includes(v))) return out;
	for (const id of listed) if (!from.includes(id) && !out.includes(id)) out.push(id);
	return out;
}

/** protocol picks the API a model is asked on: the user's choice, the only one the provider serves, or Anthropic's own for Claude models. */
export function protocolFor(p: Provider, model: string): Protocol {
	const api = p.modelPrefs?.[model]?.api;
	if (api) return api;
	const chat = endpoint(p, 'chat'), messages = endpoint(p, 'anthropic');
	return !chat || (messages && model.toLowerCase().includes('claude')) ? 'anthropic' : 'chat';
}
