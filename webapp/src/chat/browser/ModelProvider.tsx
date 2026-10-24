import { useEffect, useState, type FormEvent } from 'react';
import { api, type Connection } from '../api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog';
import type { OpenRouterSignIn, ProviderForm } from './providers';
import { finishOpenRouterSignIn, pendingOpenRouterSignIn, startOpenRouter } from './openrouter';

// The presets a browser can call: vendors that need a key. The model list
// comes from the vendor once the key is saved.
const services = [
	{ id: 'openai', name: 'OpenAI' },
	{ id: 'anthropic', name: 'Anthropic' },
	{ id: 'openrouter', name: 'OpenRouter' },
	{ id: 'deepseek', name: 'DeepSeek' },
	{ id: 'google', name: 'Google Gemini' },
	{ id: 'moonshot', name: 'Kimi' },
	{ id: 'zhipu', name: 'Zhipu GLM' },
	{ id: '', name: 'Custom API' },
];

type Saved = { default: string; providers: { id: string; name?: string; key?: string; chat?: string; anthropic?: string }[] };

/** ModelProvider sets the model provider of the browser runner, which has no `mob provider add`. */
export function ModelProvider({ connection, open, onOpenChange, onSaved, signIn }: { connection: Connection; open: boolean; onOpenChange: (open: boolean) => void; onSaved?: (model: string) => void; signIn?: OpenRouterSignIn }) {
	const [form, setForm] = useState<ProviderForm>({ preset: 'openai', url: '', protocol: 'chat', key: '', model: '' });
	const [saved, setSaved] = useState<Saved>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
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
	async function save(event: FormEvent) {
		event.preventDefault();
		await submit('/plugins/browser/provider', form);
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
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="connect-dialog">
				<DialogTitle className="dialog-title">Model provider</DialogTitle>
				<DialogDescription className="dialog-description">
					Mob in this browser calls the provider directly, so it must accept requests from browsers. The key is kept in this browser only.
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
						{form.preset === 'openrouter' && <>
							<Button type="button" variant="outline" className="provider-signin" onClick={() => void startOpenRouter().catch(e => setError(String(e)))}>Sign in with OpenRouter</Button>
							<p>OpenRouter creates a key for Mob in your account, which you can limit or revoke there. Or paste a key:</p>
						</>}
						<Label htmlFor="provider-key">API key</Label>
						<Input id="provider-key" type="password" autoComplete="off" value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} required />
						<Label htmlFor="provider-model">Model (optional)</Label>
						<Input id="provider-model" placeholder="The first model the provider lists" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} />
						<Button disabled={busy}>{busy ? 'Checking…' : 'Save'}</Button>
					</fieldset>
				</form>
				{notice && <p role="status">{notice}</p>}
				{error && <p role="alert">{error}</p>}
			</DialogContent>
		</Dialog>
	);
}
