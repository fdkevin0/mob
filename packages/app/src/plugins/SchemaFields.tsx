// A plugin's configuration form, built from its schema's metadata: each
// titled value is a field; a credential is a password field whose saved state
// the public view reports at its flag; a nested object is its own section.
import { Button } from '@mob/ui/button';
import { Label } from '@mob/ui/label';
import { jsonSchema, pluginConfigs } from '@mob/core';
import { Field, Toggle } from './shared';

/** Node is the part of a JSON Schema the form reads. */
export type Node = { type?: string; title?: string; description?: string; secret?: boolean; flag?: string; enum?: string[]; options?: string[]; properties?: Record<string, Node> };

/** schemas are the bundled plugins' configuration schemas, as JSON Schema. */
export const schemas = Object.fromEntries(Object.entries(pluginConfigs).map(([k, s]) => [k, jsonSchema(s) as Node])) as Record<keyof typeof pluginConfigs, Node>;

type Value = Record<string, any>;

const choice = (v: string) => v ? v.toUpperCase() : 'Choose…';

/** SchemaFields edits value as schema describes it; keys, when given, limits it to those values. */
export function SchemaFields({ schema, value, onChange, keys }: { schema: Node; value: Value; onChange: (v: Value) => void; keys?: string[] }) {
	const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
	return <>{Object.entries(schema.properties ?? {}).filter(([k, n]) => n.title && (!keys || keys.includes(k))).map(([k, n]) => {
		const title = n.title!;
		if (n.type === 'object') return <section key={k}><h2>{title}</h2><SchemaFields schema={n} value={value[k] ?? {}} onChange={v => set(k, v)} /></section>;
		if (n.type === 'boolean') return <Toggle key={k} value={!!value[k]} onChange={v => set(k, v)}>{title}</Toggle>;
		const options = n.enum ?? n.options;
		if (options) return <Label key={k} className="plugin-field">{title}<select value={value[k] ?? ''} onChange={e => set(k, e.target.value)}>{options.map(o => <option key={o} value={o}>{choice(o)}</option>)}</select></Label>;
		if (n.type === 'integer' || n.type === 'number') return <Field key={k} label={title} type="number" value={value[k] || ''} hint={n.description} onChange={v => set(k, Number(v))} />;
		const saved = n.secret && n.flag && value[n.flag];
		return <Field key={k} label={title} secret={n.secret} value={value[k]} hint={saved ? 'Saved. Leave blank to keep it.' : n.description} onChange={v => set(k, v)} />;
	})}</>;
}

/** secretPaths are the dotted paths of every credential in schema. */
export function secretPaths(schema: Node, prefix = ''): string[] {
	return Object.entries(schema.properties ?? {}).flatMap(([k, n]) => n.type === 'object' ? secretPaths(n, prefix + k + '.') : n.secret ? [prefix + k] : []);
}

/** ClearSecrets marks saved credentials to be cleared on the next save, while the plugin is disabled. */
export function ClearSecrets({ schema, enabled, secrets, clear }: { schema: Node; enabled: boolean; secrets: Record<string, unknown>; clear: (path: string) => void }) {
	return <div>{secretPaths(schema).map(p => <Button key={p} type="button" variant="ghost" disabled={enabled || !!secrets[p]} onClick={() => clear(p)}>{secrets[p] ? `Will clear ${p} on save` : `Clear saved ${p}`}</Button>)}<small>Disable the plugin before clearing saved credentials, then save.</small></div>;
}
