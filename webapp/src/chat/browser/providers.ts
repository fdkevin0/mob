// Model providers in the browser runner. A browser has no `mob provider add`,
// so the page saves one provider at a time through the plugin route
// POST /api/plugins/browser/provider. Only vendors that accept cross-origin
// requests work here, which is why the free OpenCode Zen tier is not offered.
import { HTTPError, findPreset, validateProvider, type Plugin, type Provider, type ProviderRegistry, type ProvidersFile } from '@mob/core';

/** browserProviders is where the browser runner starts: the offline demo model, until a provider is saved. */
export const browserProviders = (): ProvidersFile => ({ default: 'demo/echo', providers: [] });

/** ProviderForm is what the page submits: a preset, or a custom base URL and the protocol it speaks. */
export type ProviderForm = { preset: string; url?: string; protocol?: 'chat' | 'anthropic'; key: string; model?: string };

// Anthropic refuses browser requests that do not say they mean it. Only a
// provider that speaks Anthropic alone gets the header: other vendors would
// refuse it in their CORS preflight.
const browserAccess = { 'anthropic-dangerous-direct-browser-access': 'true' };

export function providerPlugin(registry: ProviderRegistry): Plugin {
	return {
		name: 'browser',
		routes: [{
			method: 'POST', path: 'provider',
			handle: async req => {
				const form = await req.json() as ProviderForm;
				const preset = form.preset ? findPreset(form.preset) : undefined;
				if (form.preset && (!preset || preset.noKey || preset.id === 'opencode')) throw new HTTPError(400, 'This provider cannot be used from a browser.');
				const key = form.key?.trim();
				if (!key) throw new HTTPError(400, 'Enter an API key.');
				const p: Provider = preset ? { id: preset.id, preset: preset.id, key } : { id: 'custom', name: 'Custom', key };
				if (!preset) {
					const url = form.url?.trim().replace(/\/+$/, '') ?? '';
					if (!url) throw new HTTPError(400, 'Enter the API base URL.');
					if (form.protocol === 'anthropic') p.anthropic = url; else p.chat = url;
				}
				if (preset ? preset.anthropic && !preset.chat : form.protocol === 'anthropic') p.headers = browserAccess;
				try { validateProvider(p); } catch (e) { throw new HTTPError(400, (e as Error).message); }
				let listed: string[] = [];
				let listError = '';
				try { listed = await registry.fetch(p, AbortSignal.timeout(20_000)); } catch (e) { listError = (e as Error).message; }
				const model = form.model?.trim().replace(new RegExp('^' + p.id + '/'), '') || (listed.length ? preset?.default && listed.includes(preset.default) ? preset.default : listed[0] : '');
				// A vendor that lists nothing may still answer, so a named model saves without its list.
				if (!model) throw new HTTPError(502, `Could not list ${preset?.name ?? 'the provider'}’s models${listError ? ': ' + listError : ''}. Check the key and URL, or name a model.`);
				registry.update(f => {
					const i = f.providers.findIndex(q => q.id === p.id);
					if (i >= 0) f.providers[i] = p; else f.providers.push(p);
					f.default = p.id + '/' + model;
				});
				return { default: p.id + '/' + model, models: listed.length };
			},
		}],
	};
}
