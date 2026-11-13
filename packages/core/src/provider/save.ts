// Saving a model provider from a form, as the web's Model provider dialog
// submits it: POST /api/providers on a runner, and the browser runner's own
// plugin route, which only offers vendors a browser can call.
import { HTTPError } from '../app/http';
import { findPreset } from './presets';
import { validateProvider, type Provider } from './provider';
import type { ProviderRegistry } from './registry';

/** ProviderForm is what the page submits: a preset, or a custom base URL and the protocol it speaks. */
export type ProviderForm = { preset: string; url?: string; protocol?: 'chat' | 'anthropic'; key: string; model?: string };

// Without a named model, OpenRouter routes each request to a model it picks.
const preferred: Record<string, string> = { openrouter: 'openrouter/auto' };

/**
 * providerFromForm turns a submitted form into the provider it saves. A key is
 * required unless the preset is a local server; a form without a preset names
 * a custom API by its base URL.
 */
export function providerFromForm(form: ProviderForm): Provider {
	const presetName = form.preset?.trim();
	const preset = presetName ? findPreset(presetName) : undefined;
	if (presetName && !preset) throw new HTTPError(400, 'Mob does not know this provider.');
	const key = form.key?.trim();
	if (!key && !preset?.noKey) throw new HTTPError(400, 'Enter an API key.');
	const p: Provider = preset ? { id: preset.id, preset: preset.id } : { id: 'custom', name: 'Custom' };
	if (key) p.key = key;
	if (!preset) {
		const url = (form.url?.trim() ?? '').replace(/\/+$/, '');
		if (!url) throw new HTTPError(400, 'Enter the API base URL.');
		if (form.protocol === 'anthropic') p.anthropic = url;
		else p.chat = url;
	}
	return p;
}

/** saveProvider lists the provider's models, then saves it with the named model, or the first listed, as the default. */
export async function saveProvider(registry: ProviderRegistry, p: Provider, named?: string) {
	try {
		validateProvider(p);
	} catch (e) {
		throw new HTTPError(400, (e as Error).message);
	}
	const preset = findPreset(p.preset);
	let listed: string[] = [];
	let listError = '';
	try {
		listed = await registry.fetch(p, AbortSignal.timeout(20_000));
	} catch (e) {
		listError = (e as Error).message;
	}
	// Workers AI lists many models that cannot call tools, so one that can comes first.
	const tools = listed.find(id => registry.info(p, id).tools) ?? '';
	const free = p.id === 'openrouter' ? listed.map(id => registry.info(p, id)).filter(i => i.free && i.tools) : [];
	const fallback = [(free.find(i => i.known) ?? free[0])?.id || (p.id === 'cloudflare' ? tools : ''), preferred[p.id], tools].find(m => m && listed.includes(m)) ?? listed[0] ?? '';
	// A vendor's own ID wins, as OpenRouter's openrouter/auto does; otherwise a Mob reference loses its provider prefix.
	const typed = named?.trim() ?? '';
	const model = (listed.includes(typed) ? typed : typed.startsWith(p.id + '/') ? typed.slice(p.id.length + 1) : typed) || fallback;
	// A vendor that lists nothing may still answer, so a named model saves without its list.
	if (!model) throw new HTTPError(502, `Could not list ${preset?.name ?? 'the provider'}’s models${listError ? ': ' + listError : ''}. Check the key and URL, or name a model.`);
	registry.update(f => {
		const i = f.providers.findIndex(q => q.id === p.id);
		if (i >= 0) f.providers[i] = p;
		else f.providers.push(p);
		f.default = p.id + '/' + model;
	});
	return { default: p.id + '/' + model, models: listed.length };
}
