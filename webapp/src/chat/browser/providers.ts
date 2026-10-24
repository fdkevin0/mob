// Model providers in the browser runner. A browser has no `mob provider add`,
// so the page saves one provider at a time through the plugin route
// POST /api/plugins/browser/provider. Only vendors that accept cross-origin
// requests work here, which is why the free OpenCode Zen tier is not offered.
import { HTTPError, findPreset, providerFromForm, saveProvider, type Plugin, type Provider, type ProviderForm, type ProviderRegistry, type ProvidersFile } from '@mob/core';

/** browserProviders is where the browser runner starts: the offline demo model, until a provider is saved. */
export const browserProviders = (): ProvidersFile => ({ default: 'demo/echo', providers: [] });

export type { ProviderForm };

// Anthropic refuses browser requests that do not say they mean it. Only a
// provider that speaks Anthropic alone gets the header: other vendors would
// refuse it in their CORS preflight.
const browserAccess = { 'anthropic-dangerous-direct-browser-access': 'true' };

/** OpenRouterSignIn is what OpenRouter's PKCE sign-in returns to the page: its code, and the verifier the page made. */
export type OpenRouterSignIn = { code: string; verifier: string };

export function providerPlugin(registry: ProviderRegistry, fetcher: typeof fetch = (input, init) => fetch(input, init)): Plugin {
	const save = (p: Provider, named?: string) => saveProvider(registry, p, named);
	return {
		name: 'browser',
		routes: [{
			method: 'POST', path: 'provider',
			handle: async req => {
				const form = await req.json() as ProviderForm;
				const preset = form.preset ? findPreset(form.preset) : undefined;
				if (form.preset && (!preset || preset.noKey || preset.id === 'opencode')) throw new HTTPError(400, 'This provider cannot be used from a browser.');
				// A browser calls the vendor itself, with the key it keeps.
				if (!form.key?.trim()) throw new HTTPError(400, 'Enter an API key.');
				const p = providerFromForm(form);
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
