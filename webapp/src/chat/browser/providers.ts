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

/** OpenRouterSignIn is what OpenRouter's PKCE sign-in returns to the page: its code, and the verifier the page made. */
export type OpenRouterSignIn = { code: string; verifier: string };

// Without a named model, OpenRouter routes each request to a model it picks.
const preferred: Record<string, string> = { openrouter: 'openrouter/auto' };

// OpenRouter is how the browser gets free models, so a free one that takes
// tools comes first: a catalogued one, then one only its :free name marks.
function freeModel(registry: ProviderRegistry, p: Provider, listed: string[]) {
	const free = listed.map(id => registry.info(p, id)).filter(i => i.free && i.tools);
	return (free.find(i => i.known) ?? free[0])?.id;
}

export function providerPlugin(registry: ProviderRegistry, fetcher: typeof fetch = (input, init) => fetch(input, init)): Plugin {
	// save lists the provider's models, then makes the named one, or the first listed, the default.
	async function save(p: Provider, named?: string) {
		try { validateProvider(p); } catch (e) { throw new HTTPError(400, (e as Error).message); }
		const preset = findPreset(p.preset);
		let listed: string[] = [];
		let listError = '';
		try { listed = await registry.fetch(p, AbortSignal.timeout(20_000)); } catch (e) { listError = (e as Error).message; }
		const fallback = [p.id === 'openrouter' ? freeModel(registry, p, listed) : '', preferred[p.id], preset?.default].find(m => m && listed.includes(m)) ?? listed[0] ?? '';
		// A vendor's own ID wins, as OpenRouter's openrouter/auto does; otherwise a Mob reference loses its provider prefix.
		const typed = named?.trim() ?? '';
		const model = (listed.includes(typed) ? typed : typed.startsWith(p.id + '/') ? typed.slice(p.id.length + 1) : typed) || fallback;
		// A vendor that lists nothing may still answer, so a named model saves without its list.
		if (!model) throw new HTTPError(502, `Could not list ${preset?.name ?? 'the provider'}’s models${listError ? ': ' + listError : ''}. Check the key and URL, or name a model.`);
		registry.update(f => {
			const i = f.providers.findIndex(q => q.id === p.id);
			if (i >= 0) f.providers[i] = p; else f.providers.push(p);
			f.default = p.id + '/' + model;
		});
		return { default: p.id + '/' + model, models: listed.length };
	}
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
				return save(p, form.model);
			},
		}, {
			// OpenRouter trades the code its sign-in returned, with the verifier only this browser knows, for a key of the user's account.
			method: 'POST', path: 'openrouter',
			handle: async req => {
				const { code, verifier } = await req.json() as OpenRouterSignIn;
				if (!code || !verifier) throw new HTTPError(400, 'The OpenRouter sign-in did not finish. Sign in again.');
				const response = await fetcher('https://openrouter.ai/api/v1/auth/keys', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
					signal: AbortSignal.timeout(20_000),
				});
				const body = await response.json().catch(() => ({})) as { key?: string };
				if (!response.ok || !body.key) throw new HTTPError(502, `OpenRouter did not give a key (HTTP ${response.status}). Sign in again.`);
				return save({ id: 'openrouter', preset: 'openrouter', key: body.key });
			},
		}],
	};
}
