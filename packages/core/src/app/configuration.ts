// Plugin configuration saved in SQLite, one section per plugin. A section
// says how a submitted configuration is checked and merged with the saved
// one, which credentials it holds, and how its connection is tested.
// Bundled plugins' schemas are in plugin-config.ts.
import { z } from 'zod';
import type { Store } from '../chat/store';

/** Secret is a credential at a dotted path, shown to clients only as the boolean at flag. A blank submission keeps the saved value while owner is unchanged; no owner never changes. */
export type Secret<C> = { name: string; flag: string; owner?: (c: C) => string };

export type Section<C = any> = {
	name: string;
	/** title names the plugin in menus; label in messages, e.g. "Telegram is disabled". */
	title: string;
	label: string;
	/** schema is the configuration's shape and defaults; an empty object parses to the configuration of a plugin never saved. */
	schema: z.ZodType<C>;
	secrets: Secret<C>[];
	enabled: (c: C) => boolean;
	/** validate checks what the schema cannot, such as the values an enabled plugin needs. */
	validate: (c: C) => void;
	test: (c: C, signal: AbortSignal) => Promise<unknown>;
};

/** SecretUpdate distinguishes an omitted or kept credential from an explicit clear. */
export type SecretUpdate = { mode: '' | 'keep' | 'clear' | 'replace'; value?: string };

/** parse checks raw against a section's schema, filling defaults; the public flags beside credentials are dropped. */
function parse<C>(section: Section<C>, raw: unknown): C {
	const r = section.schema.safeParse(raw);
	if (!r.success) throw new Error('invalid configuration:\n' + z.prettifyError(r.error));
	for (const v of section.secrets) unset(r.data, v.flag);
	return r.data;
}

/** defaults is the configuration of a plugin never saved. */
export const sectionDefaults = <C>(section: Section<C>) => parse(section, {});

const get = (c: unknown, path: string) => path.split('.').reduce<any>((v, k) => v?.[k], c) as string | undefined;
function setValue(c: unknown, path: string, value: unknown) {
	const keys = path.split('.');
	const last = keys.pop()!;
	(keys.reduce<any>((v, k) => v[k], c))[last] = value;
}

function unset(c: unknown, path: string) {
	const keys = path.split('.');
	const last = keys.pop()!;
	const parent = keys.reduce<any>((v, k) => v?.[k], c);
	if (parent && typeof parent === 'object') delete parent[last];
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
			try { out[s.name] = parse(s, saved[s.name] ?? {}); } catch { out[s.name] = sectionDefaults(s); }
		}
		return out;
	}

	/** publicConfig is every plugin's configuration with its credentials withheld, each replaced by whether it is set. */
	publicConfig(c = this.config()) {
		return Object.fromEntries(this.sections.map(s => {
			const p = structuredClone(c[s.name]);
			for (const v of s.secrets) { setValue(p, v.flag, !!get(p, v.name)); unset(p, v.name); }
			return [s.name, p];
		}));
	}

	/** update saves one plugin's submitted configuration and returns every plugin's. */
	update(name: string, raw: Record<string, unknown>): Record<string, any> {
		const section = this.lookup(name);
		if (!section) throw new Error('unknown plugin');
		const c = this.config();
		const { secrets: rawUpdates, ...payload } = raw;
		const updates = (rawUpdates ?? {}) as Record<string, SecretUpdate>;
		if (typeof updates !== 'object' || Array.isArray(updates)) throw new Error('invalid configuration');
		const next = parse(section, payload);
		const old = c[name];
		for (const v of section.secrets) {
			const same = !v.owner || v.owner(next) === v.owner(old);
			setValue(next, v.name, resolveSecret(get(old, v.name) ?? '', get(next, v.name) ?? '', same, updates[v.name]));
		}
		for (const key of Object.keys(updates)) if (!section.secrets.some(s => s.name === key)) throw new Error('unknown secret field');
		section.validate(next);
		c[name] = next;
		this.store.saveSetting('plugins', c);
		return c;
	}
}
