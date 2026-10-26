import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { findPreset } from '@mob/core/provider/presets';
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw';
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw';
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';
import workersai from '@lobehub/icons-static-svg/icons/workersai-color.svg?raw';
import { api, type Connection } from './api';
import { BrandIcon, vendorLogos } from './brandIcons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Segmented } from '../components/ui/segmented';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { CheckIcon, ChevronIcon, KeyIcon, OpenIcon, PlugIcon } from './icons';
import type { OpenRouterSignIn, ProviderForm } from './browser/providers';
import { finishOpenRouterSignIn, pendingOpenRouterSignIn, startOpenRouter } from './browser/openrouter';
import { chromeModelSupported, prepareChromeModel } from './browser/chrome';

const { openai, anthropic, deepseek, gemini, kimi, zhipu } = vendorLogos;

// What a provider tile shows. The model list comes from the vendor once the key is saved.
type Service = { id: string; name: string; tagline: string; svg?: string; noKey?: boolean };
type Group = { title: string; services: Service[] };

const openRouter: Service = { id: 'openrouter', name: 'OpenRouter', tagline: 'Hundreds of models, some free', svg: openrouter };
const keyed: Service[] = [
	{ id: 'openai', name: 'OpenAI', tagline: 'GPT models', svg: openai },
	{ id: 'anthropic', name: 'Anthropic', tagline: 'Claude models', svg: anthropic },
	{ id: 'deepseek', name: 'DeepSeek', tagline: 'DeepSeek models', svg: deepseek },
	{ id: 'google', name: 'Google Gemini', tagline: 'Gemini models', svg: gemini },
	{ id: 'moonshot', name: 'Kimi', tagline: 'Moonshot’s Kimi models', svg: kimi },
	{ id: 'zhipu', name: 'Zhipu GLM', tagline: 'GLM models', svg: zhipu },
];
const custom: Service = { id: '', name: 'Custom API', tagline: 'Any OpenAI or Anthropic API' };

// OpenRouter leads in the browser, since its sign-in is the browser's way to free models. Workers AI through the
// site's sign-in, and Chrome's model in the page itself, only the browser runner has.
const browserGroups = (): Group[] => [
	{
		title: 'Free to start',
		services: [
			{ ...openRouter, tagline: 'Sign in for free models' },
			{ id: 'cloudflare', name: 'Workers AI', tagline: 'Your Cloudflare account', svg: workersai },
			...(chromeModelSupported() ? [{ id: 'chrome', name: 'Chrome built-in', tagline: 'Gemini Nano, on this device', svg: gemini }] : []),
		],
	},
	{ title: 'With an API key', services: [...keyed, custom] },
];
// A runner calls the vendor itself, so it can also reach model servers on its own machine, which need no key.
const runnerGroups = (where: string): Group[] => [
	{ title: 'With an API key', services: [openRouter, ...keyed] },
	{
		title: `On ${where}`,
		services: [
			{ id: 'ollama', name: 'Ollama', tagline: 'Local models, no key', svg: ollama, noKey: true },
			{ id: 'lmstudio', name: 'LM Studio', tagline: 'Local models, no key', svg: lmstudio, noKey: true },
			custom,
		],
	},
];

type SavedProvider = { id: string; name?: string; preset?: string; key?: string; chat?: string; anthropic?: string };
type Saved = { default: string; providers: SavedProvider[] };

function Logo({ service, size = 20 }: { service?: Service; size?: number }) {
	return (
		<span className="provider-logo" style={{ width: size + 12, height: size + 12 }}>
			{service?.svg ? <BrandIcon brand={{ name: service.name, svg: service.svg }} size={size} /> : <PlugIcon />}
		</span>
	);
}

/**
 * ModelProvider connects a model provider and makes it the default, as `mob provider add` does on a runner's command
 * line: a list of providers, connected ones first, then one provider's sign-in or key. The browser runner keeps the
 * key in this browser and calls only vendors that accept browsers; a runner keeps it in its providers.json.
 */
export function ModelProvider({ connection, open, onOpenChange, onSaved, signIn }: { connection: Connection; open: boolean; onOpenChange: (open: boolean) => void; onSaved?: (model: string) => void; signIn?: OpenRouterSignIn }) {
	const [chosen, setChosen] = useState<Service>();
	// editing is the connected provider whose page is open, whose key the page replaces.
	const [editing, setEditing] = useState<SavedProvider>();
	const [form, setForm] = useState<ProviderForm>({ preset: 'openrouter', url: '', protocol: 'chat', key: '', model: '' });
	const [saved, setSaved] = useState<Saved>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [done, setDone] = useState<{ model: string; models: number }>();
	const [progress, setProgress] = useState<number>();
	const browser = !!connection.browser;
	const where = connection.runner ? 'your runner' : 'this computer';
	const groups = browser ? browserGroups() : runnerGroups(where);
	const services = groups.flatMap((g) => g.services);
	useEffect(() => {
		if (!open) return;
		setError('');
		setDone(undefined);
		setChosen(undefined);
		api<Saved>(connection, '/providers').then(setSaved).catch(() => setSaved(undefined));
	}, [open, connection]);
	// A sign-in OpenRouter sent the user back from is finished as the dialog opens.
	useEffect(() => {
		if (!open || !signIn || pendingOpenRouterSignIn() !== signIn) return;
		finishOpenRouterSignIn();
		choose(services.find((s) => s.id === 'openrouter')!);
		void submit('/plugins/browser/openrouter', signIn);
	}, [open, signIn]);
	function choose(service: Service | undefined, row?: SavedProvider) {
		setChosen(service);
		setEditing(row);
		setError('');
		setDone(undefined);
		// A custom provider is saved again with its own endpoint, so only its key changes.
		const url = service?.id === '' ? (row?.chat ?? row?.anthropic ?? '') : '';
		const protocol = service?.id === '' && row?.anthropic && !row.chat ? 'anthropic' : 'chat';
		if (service) setForm({ preset: service.id, url, protocol, key: '', model: '' });
	}
	const cloudflare = browser && chosen?.id === 'cloudflare';
	const chrome = browser && chosen?.id === 'chrome';
	async function save(event: FormEvent) {
		event.preventDefault();
		if (chrome) await useChrome();
		else if (cloudflare) await submit('/plugins/browser/cloudflare', { model: form.model });
		else await submit(browser ? '/plugins/browser/provider' : '/providers', form);
	}
	// Chrome downloads its model only after a click, so the download starts here, before the save.
	async function useChrome() {
		setBusy(true);
		setError('');
		try {
			await prepareChromeModel((loaded) => setProgress(Math.round(loaded * 100)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
			return;
		} finally {
			setProgress(undefined);
		}
		await submit('/plugins/browser/chrome', {});
	}
	async function submit(path: string, body: object) {
		setBusy(true);
		setError('');
		try {
			const result = await api<{ default: string; models: number }>(connection, path, body);
			setForm((f) => ({ ...f, key: '' }));
			setDone({ model: result.default, models: result.models });
			setSaved(await api<Saved>(connection, '/providers').catch(() => saved));
			onSaved?.(result.default);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	const connected = saved?.providers ?? [];
	const defaultProvider = saved?.default.slice(0, saved.default.indexOf('/'));
	// A connected provider opens where this dialog would save it again under the same ID: a preset as it is, at
	// the preset's own address, or the custom API, with its endpoint. Others, such as one named on the command
	// line, are changed there, since saving them here would replace a different provider.
	const editable = (p: SavedProvider): Service | undefined => {
		if (p.id === 'custom' && !p.preset) return { ...custom, name: p.name || custom.name };
		const preset = findPreset(p.id);
		if (!preset || p.preset !== p.id || p.chat || p.anthropic) return undefined;
		return services.find((s) => s.id === p.id) ?? { id: p.id, name: p.name || preset.name, tagline: '', noKey: preset.noKey };
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="provider-dialog">
				{!chosen ? (
					<>
						<DialogTitle className="dialog-title">Model providers</DialogTitle>
						<DialogDescription className="dialog-description">
							{browser ? 'Mob in this browser calls each provider directly, with keys kept in this browser only.' : `Mob calls each provider from ${where}, with keys kept in its providers.json.`}
						</DialogDescription>
						{connected.length > 0 && (
							<section className="provider-section" aria-labelledby="providers-connected">
								<h3 id="providers-connected">Connected</h3>
								<ul className="provider-connected">
									{connected.map((p) => {
										const service = editable(p);
										const isDefault = p.id === defaultProvider;
										const look = service ?? services.find((s) => s.id === (p.preset || p.id));
										const row = (
											<>
												<Logo service={look} />
												<span className="provider-text">
													<span className="provider-name">{p.name || look?.name || p.id}</span>
													<span className="provider-sub">{[p.key, isDefault && saved?.default.slice(p.id.length + 1), !service && 'change it with mob provider add'].filter(Boolean).join(' · ') || 'No key'}</span>
												</span>
												{isDefault && <span className="provider-badge">Default</span>}
											</>
										);
										return (
											<li key={p.id}>
												{service ? (
													<button type="button" onClick={() => choose(service, p)}>
														{row}
														<ChevronIcon />
													</button>
												) : (
													<div className="provider-fixed">{row}</div>
												)}
											</li>
										);
									})}
								</ul>
							</section>
						)}
						{groups.map((group) => (
							<section key={group.title} className="provider-section" aria-label={group.title}>
								<h3>{group.title}</h3>
								<div className="provider-grid">
									{group.services.map((service) => (
										<button key={service.id || 'custom'} type="button" className="provider-tile" onClick={() => choose(service, connected.find((p) => service.id && p.id === service.id && editable(p)))}>
											<Logo service={service} />
											<span className="provider-text">
												<span className="provider-name">{service.name}</span>
												<span className="provider-sub">{service.tagline}</span>
											</span>
										</button>
									))}
								</div>
							</section>
						))}
					</>
				) : (
					<>
						<div className="provider-head">
							<Button type="button" variant="ghost" className="provider-back" aria-label="All providers" onClick={() => choose(undefined)}>
								<ChevronIcon />
							</Button>
							<Logo service={chosen} size={22} />
							<DialogTitle className="dialog-title">{chosen.name}</DialogTitle>
						</div>
						<DialogDescription className="dialog-description">{about(chosen, browser, where)}</DialogDescription>
						{done ? (
							<div className="provider-done" role="status">
								<span className="provider-done-mark">
									<CheckIcon />
								</span>
								<p>
									Connected. Conversations that follow the default now use <strong>{done.model}</strong>
									{done.models ? `, and the model picker lists its ${done.models} models` : ''}.
								</p>
								<div className="provider-actions">
									<Button type="button" variant="outline" onClick={() => choose(undefined)}>
										Connect another
									</Button>
									<Button type="button" onClick={() => onOpenChange(false)}>
										Done
									</Button>
								</div>
							</div>
						) : (
							<form onSubmit={save}>
								<fieldset disabled={busy} className="provider-form">
									<ProviderFields browser={browser} chosen={chosen} form={form} setForm={setForm} setError={setError} connectedKey={editing?.key} />
									{error && (
										<p className="provider-error" role="alert">
											{error}
										</p>
									)}
									<div className="provider-actions">
										<Button type="button" variant="ghost" onClick={() => choose(undefined)}>
											Back
										</Button>
										<Button disabled={busy} variant={browser && chosen.id === 'openrouter' ? 'outline' : undefined}>
											{progress !== undefined ? `Downloading the model… ${progress}%` : busy ? 'Checking…' : chrome ? 'Download and use' : cloudflare ? 'Use my Cloudflare account' : browser && chosen.id === 'openrouter' ? 'Connect with this key' : 'Connect'}
										</Button>
									</div>
								</fieldset>
							</form>
						)}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

// about says what connecting a provider means, in a sentence or two.
function about(service: Service, browser: boolean, where: string) {
	if (service.id === 'openrouter' && browser) return 'Sign in and OpenRouter creates a key for Mob in your account, which you can limit or revoke there. Mob starts on a free model, which has daily limits; paid ones are in the model picker.';
	if (service.id === 'openrouter') return 'One key for hundreds of models from many vendors, some of them free.';
	if (service.id === 'cloudflare') return 'Mob uses Workers AI of the Cloudflare account you signed in with, or connected on your account page. Workers AI includes a daily free allowance.';
	if (service.id === 'chrome') return 'Chrome runs Gemini Nano on this device: free, private and offline once downloaded.';
	if (service.id === '') return 'Any server that speaks the OpenAI Chat Completions or Anthropic Messages API.';
	const preset = findPreset(service.id);
	if (service.noKey) return `Mob calls ${service.name} at ${preset?.chat ?? 'its usual address'} on ${where}. A key is needed only if you set one there.`;
	return `Paste a key from your ${service.name} account. Mob then lists its models in the model picker.`;
}

function ProviderFields({ browser, chosen, form, setForm, setError, connectedKey }: { browser: boolean; chosen: Service; form: ProviderForm; setForm: (form: ProviderForm) => void; setError: (error: string) => void; connectedKey?: string }) {
	const keysUrl = findPreset(chosen.id)?.keysUrl;
	if (browser && chosen.id === 'chrome')
		return (
			<ul className="provider-facts">
				<li>Downloads once, about 4 GB; needs Chrome 148 or later on a desktop.</li>
				<li>A small model that reads and writes English, Spanish and Japanese best.</li>
				<li>It can only reply: it cannot use tools or run tasks.</li>
			</ul>
		);
	const model = (
		<details className="provider-advanced">
			<summary>Default model</summary>
			<Label htmlFor="provider-model">Model ID (optional)</Label>
			<Input id="provider-model" placeholder="The first model the provider lists" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
		</details>
	);
	if (browser && chosen.id === 'cloudflare') return model;
	let signIn: ReactNode = null;
	if (browser && chosen.id === 'openrouter')
		signIn = (
			<>
				<Button type="button" className="provider-signin" onClick={() => void startOpenRouter().catch((e) => setError(String(e)))}>
					Sign in with OpenRouter
				</Button>
				<div className="provider-or">or paste a key</div>
			</>
		);
	return (
		<>
			{signIn}
			{chosen.id === '' && (
				<>
					<Label htmlFor="provider-url">API base URL</Label>
					<Input id="provider-url" type="url" placeholder="https://api.example.com/v1" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required />
					<span className="provider-label">API format</span>
					<Segmented<'chat' | 'anthropic'>
						label="API format"
						className="provider-protocol"
						value={form.protocol ?? 'chat'}
						onChange={(protocol) => setForm({ ...form, protocol })}
						options={[
							{ value: 'chat', label: 'OpenAI Chat Completions' },
							{ value: 'anthropic', label: 'Anthropic Messages' },
						]}
					/>
					<small className="provider-hint">{form.protocol === 'chat' ? 'The base URL usually ends in /v1.' : 'The base URL without /v1.'}</small>
				</>
			)}
			<div className="provider-label-row">
				<Label htmlFor="provider-key">{chosen.noKey ? 'API key (optional)' : 'API key'}</Label>
				{keysUrl && (
					<a href={keysUrl} target="_blank" rel="noreferrer">
						Get a key <OpenIcon />
					</a>
				)}
			</div>
			<Input
				id="provider-key"
				type="password"
				autoComplete="off"
				placeholder={connectedKey ? `Connected as ${connectedKey}; paste a new key to replace it` : 'Paste your key'}
				value={form.key}
				onChange={(e) => setForm({ ...form, key: e.target.value })}
				required={!chosen.noKey}
			/>
			<small className="provider-hint">
				<KeyIcon /> {browser ? 'Kept in this browser only.' : 'Saved in providers.json, never shown again.'} Connecting makes it the default model.
			</small>
			{model}
		</>
	);
}
