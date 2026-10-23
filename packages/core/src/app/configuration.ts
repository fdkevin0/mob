// Plugin configuration saved in SQLite, one section per plugin. A section
// says how a submitted configuration is checked and merged with the saved
// one, which credentials it holds, and how its connection is tested.
import type { Store } from '../chat/store';

/** Field is one configuration value: path is its JSON key, dotted for a nested one; kind is bool, int, text or secret. */
export type Field = { path: string; label: string; kind: 'bool' | 'int' | 'text' | 'secret' };

/** Secret is a credential at a dotted path. A blank submission keeps the saved value while owner is unchanged; no owner never changes. */
export type Secret<C> = { name: string; owner?: (c: C) => string };

export type Section<C = any> = {
	name: string;
	/** title names the plugin in menus; label in messages, e.g. "Telegram is disabled". */
	title: string;
	label: string;
	/** fields describe the configuration for clients that build their form from it. */
	fields: Field[];
	secrets: Secret<C>[];
	/** defaults is the configuration of a plugin never saved; its shape is the only one accepted. */
	defaults: () => C;
	enabled: (c: C) => boolean;
	validate: (c: C) => void;
	/** publicView is the configuration with its credentials withheld. */
	publicView: (c: C) => C;
	test: (c: C, signal: AbortSignal) => Promise<unknown>;
};

/** SecretUpdate distinguishes an omitted or kept credential from an explicit clear. */
export type SecretUpdate = { mode: '' | 'keep' | 'clear' | 'replace'; value?: string };

const invalid = () => new Error('invalid configuration');

/** conform checks raw has value's shape: the same keys, nested alike, of the same types; optional public flags (has*) are dropped. */
function conform(raw: unknown, shape: unknown): unknown {
	if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) {
		if (Array.isArray(shape)) {
			if (!Array.isArray(raw)) throw invalid();
			return raw.map(v => { if (typeof v !== 'string') throw invalid(); return v; });
		}
		if (typeof raw !== typeof shape) throw invalid();
		if (typeof shape === 'number' && !Number.isInteger(raw)) throw invalid();
		return raw;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!(k in (shape as object))) {
			if (/^has[A-Z]/.test(k) && typeof v === 'boolean') continue;
			throw invalid();
		}
		out[k] = conform(v, (shape as Record<string, unknown>)[k]);
	}
	return { ...structuredClone(shape as object), ...out };
}

const get = (c: unknown, path: string) => path.split('.').reduce<any>((v, k) => v?.[k], c) as string | undefined;
function set(c: unknown, path: string, value: string) {
	const keys = path.split('.');
	const last = keys.pop()!;
	(keys.reduce<any>((v, k) => v[k], c))[last] = value;
}

function resolveSecret(old: string, submitted: string, sameOwner: boolean, update?: SecretUpdate): string {
	switch (update?.mode ?? '') {
		case '': return submitted || (sameOwner ? old : '');
		case 'keep':
			if (!sameOwner) throw new Error('cannot keep a credential after changing its owner');
			return old;
		case 'clear': return '';
		case 'replace':
			if (!update!.value) throw new Error('replacement credential is empty');
			return update!.value;
		default: throw new Error('unknown secret update mode');
	}
}

export class PluginSettings {
	constructor(private store: Store, readonly sections: Section[]) {}

	lookup(name: string) { return this.sections.find(s => s.name === name); }

	/** config is every plugin's saved configuration, defaults where none is saved. */
	config(): Record<string, any> {
		const saved = this.store.setting<Record<string, unknown>>('plugins') ?? {};
		const out: Record<string, any> = {};
		for (const s of this.sections) {
			try { out[s.name] = saved[s.name] === undefined ? s.defaults() : conform(saved[s.name], s.defaults()); } catch { out[s.name] = s.defaults(); }
		}
		return out;
	}

	publicConfig(c = this.config()) {
		return Object.fromEntries(this.sections.map(s => [s.name, s.publicView(structuredClone(c[s.name]))]));
	}

	/** update saves one plugin's submitted configuration and returns every plugin's. */
	update(name: string, raw: Record<string, unknown>): Record<string, any> {
		const section = this.lookup(name);
		if (!section) throw new Error('unknown plugin');
		const c = this.config();
		const { secrets: rawUpdates, ...payload } = raw;
		const updates = (rawUpdates ?? {}) as Record<string, SecretUpdate>;
		if (typeof updates !== 'object' || Array.isArray(updates)) throw invalid();
		const next = conform(payload, section.defaults());
		const old = c[name];
		for (const v of section.secrets) {
			const same = !v.owner || v.owner(next) === v.owner(old);
			set(next, v.name, resolveSecret(get(old, v.name) ?? '', get(next, v.name) ?? '', same, updates[v.name]));
		}
		for (const key of Object.keys(updates)) if (!section.secrets.some(s => s.name === key)) throw new Error('unknown secret field');
		section.validate(next);
		c[name] = next;
		this.store.saveSetting('plugins', c);
		return c;
	}
}
