import { useEffect, useState, type FormEvent } from 'react';
import { api, type Connection } from './api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import type { OpenRouterSignIn, ProviderForm } from './browser/providers';
import { finishOpenRouterSignIn, pendingOpenRouterSignIn, startOpenRouter } from './browser/openrouter';
import { chromeModelSupported, prepareChromeModel } from './browser/chrome';

// The presets a browser can call: vendors that need a key. OpenRouter leads,
// since its sign-in is the browser's way to free models. The model list
// comes from the vendor once the key is saved.
type Service = { id: string; name: string; noKey?: boolean };
const browserServices: Service[] = [
	{ id: 'openrouter', name: 'OpenRouter (free models)' },
	{ id: 'cloudflare', name: 'Cloudflare Workers AI (your account)' },
	{ id: 'chrome', name: 'Chrome built-in model (experimental, offline)' },
	{ id: 'openai', name: 'OpenAI' },
	{ id: 'anthropic', name: 'Anthropic' },
	{ id: 'deepseek', name: 'DeepSeek' },
	{ id: 'google', name: 'Google Gemini' },
	{ id: 'moonshot', name: 'Kimi' },
	{ id: 'zhipu', name: 'Zhipu GLM' },
	{ id: '', name: 'Custom API' },
];
// A runner calls the vendor itself, so it can also reach model servers on its own machine, which need no key.
const local = [
	{ id: 'ollama', name: 'Ollama (on the runner)', noKey: true },
	{ id: 'lmstudio', name: 'LM Studio (on the runner)', noKey: true },
];
// Workers AI through the site's proxy needs the site's sign-in, and Chrome's model the page itself, which only the browser runner has.
const shared = browserServices.filter(s => s.id !== 'cloudflare' && s.id !== 'chrome');
const runnerServices: Service[] = [...shared.slice(0, -1), ...local, shared[shared.length - 1]];

type Saved = { default: string; providers: { id: string; name?: string; key?: string; chat?: string; anthropic?: string }[] };

/**
 * ModelProvider adds a model provider and makes it the default, as `mob provider add` does on a runner's command line.
 * The browser runner keeps the key in this browser and calls only vendors that accept browsers; a runner keeps it in its providers.json.
 */
export function ModelProvider({ connection, open, onOpenChange, onSaved, signIn }: { connection: Connection; open: boolean; onOpenChange: (open: boolean) => void; onSaved?: (model: string) => void; signIn?: OpenRouterSignIn }) {
	const [form, setForm] = useState<ProviderForm>({ preset: 'openrouter', url: '', protocol: 'chat', key: '', model: '' });
	const [saved, setSaved] = useState<Saved>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [progress, setProgress] = useState<number>();
	useEffect(() => {
		if (!open) return;
		setError(''); setNotice('');
		api<Saved>(connection, '/providers').then(setSaved).catch(() => setSaved(undefined));
	}, [open, connection]);
	// A sign-in OpenRouter sent the user back from is finished as the dialog opens.
	useEffect(() => {
		if (!open || !signIn || pendingOpenRouterSignIn() !== signIn) return;
		finishOpenRouterSignIn();
		void submit('/plugins/browser/openrouter', signIn);
	}, [open, signIn]);
	const browser = !!connection.browser;
	const services = browser ? browserServices.filter(s => s.id !== 'chrome' || chromeModelSupported()) : runnerServices;
	const noKey = services.find(s => s.id === form.preset)?.noKey;
	async function save(event: FormEvent) {
		event.preventDefault();
		if (chrome) await useChrome();
		else if (cloudflare) await submit('/plugins/browser/cloudflare', { model: form.model });
		else await submit(browser ? '/plugins/browser/provider' : '/providers', form);
	}
	// Chrome downloads its model only after a click, so the download starts here, before the save.
	async function useChrome() {
		setBusy(true); setError(''); setNotice('');
		try {
			await prepareChromeModel(loaded => setProgress(Math.round(loaded * 100)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
			return;
		} finally { setProgress(undefined); }
		await submit('/plugins/browser/chrome', {});
	}
	async function submit(path: string, body: object) {
		setBusy(true); setError(''); setNotice('');
		try {
			const result = await api<{ default: string; models: number }>(connection, path, body);
			setForm(f => ({ ...f, key: '' }));
			setSaved(await api<Saved>(connection, '/providers'));
			setNotice(`Saved. Conversations now use ${result.default}${result.models ? `; ${result.models} models are listed in the model picker` : ''}.`);
			onSaved?.(result.default);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally { setBusy(false); }
	}
	const custom = form.preset === '';
	const cloudflare = browser && form.preset === 'cloudflare';
	const chrome = browser && form.preset === 'chrome';
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="connect-dialog">
				<DialogTitle className="dialog-title">Model provider</DialogTitle>
				<DialogDescription className="dialog-description">
					{browser
						? 'Mob in this browser calls the provider directly, so it must accept requests from browsers. The key is kept in this browser only.'
						: `Mob calls the provider from ${connection.runner ? 'your runner' : 'this computer'}, which keeps the key in its providers.json. Saving makes it the default model.`}
				</DialogDescription>
				{saved && saved.providers.length > 0 && (
					<p>Now: {saved.providers.map(p => `${p.name || p.id}${p.key ? ` (${p.key})` : ''}`).join(', ')} · default {saved.default}</p>
				)}
				<form onSubmit={save}>
					<fieldset disabled={busy} className="provider-form">
						<Label htmlFor="provider-service">Service</Label>
						<select id="provider-service" value={form.preset} onChange={e => setForm({ ...form, preset: e.target.value })}>
							{services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
						</select>
						{custom && <>
							<Label htmlFor="provider-url">API base URL</Label>
							<Input id="provider-url" type="url" placeholder="https://api.example.com/v1" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} required />
							<Label htmlFor="provider-protocol">API format</Label>
							<select id="provider-protocol" value={form.protocol} onChange={e => setForm({ ...form, protocol: e.target.value as 'chat' | 'anthropic' })}>
								<option value="chat">OpenAI Chat Completions (base URL ends in /v1)</option>
								<option value="anthropic">Anthropic Messages (base URL without /v1)</option>
							</select>
						</>}
						{browser && form.preset === 'openrouter' && <>
							<Button type="button" variant="outline" className="provider-signin" onClick={() => void startOpenRouter().catch(e => setError(String(e)))}>Sign in with OpenRouter</Button>
							<p>OpenRouter creates a key for Mob in your account, which you can limit or revoke there. Mob starts on one of its free models, which have daily limits; pick a paid one in the model picker. Or paste a key:</p>
						</>}
						{chrome ? (
							<p>Chrome runs Gemini Nano on this device: free, private, and offline once downloaded. The first use downloads it once, about 4 GB, and needs Chrome 148 or later on a desktop. It is a small model that reads and writes English, Spanish and Japanese best, and it can only reply: it cannot use tools or run tasks.</p>
						) : cloudflare ? (
							<p>Mob uses Workers AI of the Cloudflare account you signed in with, or connected on your <a href="/account">account page</a>. Mob keeps the sign-in on its server and never shows the token to this page. Workers AI includes a daily free allowance.</p>
						) : <>
							<Label htmlFor="provider-key">{noKey ? 'API key (optional)' : 'API key'}</Label>
							<Input id="provider-key" type="password" autoComplete="off" value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} required={!noKey} />
						</>}
						{!chrome && <>
							<Label htmlFor="provider-model">Model (optional)</Label>
							<Input id="provider-model" placeholder="The first model the provider lists" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} />
						</>}
						<Button disabled={busy}>{progress !== undefined ? `Downloading the model… ${progress}%` : busy ? 'Checking…' : chrome ? 'Use Chrome’s model' : cloudflare ? 'Use my Cloudflare account' : 'Save'}</Button>
					</fieldset>
				</form>
				{notice && <p role="status">{notice}</p>}
				{error && <p role="alert">{error}</p>}
			</DialogContent>
		</Dialog>
	);
}
