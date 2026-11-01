import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, ok, rpcOf, type Connection } from './api';
import { Content as DialogContent } from '@radix-ui/react-dialog';
import { DialogDescription, DialogTitle } from '@mob/ui/dialog';
import { Button } from '@mob/ui/button';
import { BrandIcon, modelBrand } from './brandIcons';
import { BrainIcon, CheckIcon, EyeIcon, PlusIcon, SearchIcon, WrenchIcon } from './icons';
import { tokens } from './format';
import { Notice } from '@mob/ui/notice';

export type ModelInfo = {
	id: string;
	name?: string;
	context?: number;
	output?: number;
	reasoning?: boolean;
	/** efforts are the reasoning levels the model takes, chosen as provider/model:level. */
	efforts?: string[];
	tools: boolean;
	vision?: boolean;
	/** free is set for a model that costs nothing to call, such as OpenRouter's `:free` variants. */
	free?: boolean;
	/** cost is the list price in dollars per million tokens. */
	cost?: { input: number; output: number };
};

export type ModelGroup = {
	provider: string;
	name: string;
	models: ModelInfo[];
	error?: string;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));


/** refOf is how a conversation names a provider's model: provider/model. Some providers list their IDs with that prefix already. */
export function refOf(provider: string, model: ModelInfo) {
	return model.id.startsWith(provider + '/') ? model.id : `${provider}/${model.id}`;
}

/** withoutEffort is a model reference without its reasoning level: openai/o3:high is openai/o3. */
export function withoutEffort(ref: string, efforts: readonly string[] = knownEfforts) {
	const colon = ref.lastIndexOf(':');
	return colon > ref.indexOf('/') && efforts.includes(ref.slice(colon + 1)) ? ref.slice(0, colon) : ref;
}
const knownEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** ModelFamily is the models of one provider whose vendor ID starts with the same prefix, such as anthropic/ on OpenRouter. */
type ModelFamily = { prefix: string; models: ModelInfo[] };

// families splits a provider's models by the vendor prefix after the provider's own:
// openrouter/anthropic/claude-x belongs to anthropic. Models without one come first, together.
export function families(provider: string, models: ModelInfo[]): ModelFamily[] {
	const byPrefix = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const vendorID = model.id.startsWith(provider + '/') ? model.id.slice(provider.length + 1) : model.id;
		const slash = vendorID.indexOf('/');
		const prefix = slash > 0 ? vendorID.slice(0, slash) : '';
		byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), model]);
	}
	return [...byPrefix].map(([prefix, models]) => ({ prefix, models })).sort((a, b) => (a.prefix ? 1 : 0) - (b.prefix ? 1 : 0) || a.prefix.localeCompare(b.prefix));
}

// A family list this long starts folded, so a provider such as OpenRouter fits on a screen.
const foldAbove = 12;

// The models chosen last, kept in this browser only: a convenience, not part of any conversation.
const recentKey = 'mob-recent-models';
const recentLimit = 4;
export function recentModels(): string[] {
	try {
		const list = JSON.parse(localStorage.getItem(recentKey) ?? '[]');
		return Array.isArray(list) ? list.filter((r): r is string => typeof r === 'string').slice(0, recentLimit) : [];
	} catch {
		return [];
	}
}
function remember(ref: string) {
	try {
		localStorage.setItem(recentKey, JSON.stringify([ref, ...recentModels().filter((r) => r !== ref)].slice(0, recentLimit)));
	} catch {
		/* recents are a convenience */
	}
}

type Capability = 'reasoning' | 'vision' | 'tools' | 'free';
const capabilityFilters: { key: Capability; label: string; icon?: ReactNode }[] = [
	{ key: 'reasoning', label: 'Reasoning', icon: <BrainIcon /> },
	{ key: 'vision', label: 'Vision', icon: <EyeIcon /> },
	{ key: 'tools', label: 'Tools', icon: <WrenchIcon /> },
	{ key: 'free', label: 'Free' },
];

/** Entry is one model as the picker lists it, with the provider that serves it. */
type Entry = { group: ModelGroup; model: ModelInfo; ref: string };

/**
 * ModelPicker offers the models of every configured provider for this conversation.
 * Choosing one changes the conversation's model setting, as /model does; neither adds to the transcript.
 */
export function ModelPicker({
	connection,
	current,
	defaultModel,
	onPick,
	addProvider,
	setDefault,
}: {
	connection: Connection;
	current?: string;
	defaultModel?: string;
	onPick: (model?: string) => void;
	/** addProvider opens the Model provider dialog, for models the configured providers do not offer. */
	addProvider?: () => void;
	/** setDefault makes a model the default for conversations without their own choice. */
	setDefault?: (model: string) => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	const [groups, setGroups] = useState<ModelGroup[]>();
	const [error, setError] = useState('');
	const [query, setQuery] = useState('');
	const [wanted, setWanted] = useState<Capability[]>([]);
	const [provider, setProvider] = useState('');
	const [active, setActive] = useState<Entry>();
	const [recent] = useState(recentModels);
	useEffect(() => {
		let live = true;
		ok(rpcOf(connection).models.$get({ query: {} }))
			.then((next) => {
				if (live) setGroups(next);
			})
			.catch((e) => {
				if (live) setError(errorText(e));
			});
		return () => {
			live = false;
		};
	}, [connection]);
	useLayoutEffect(() => {
		const resize = () => {
			const element = panel.current;
			if (!element?.parentElement || window.matchMedia?.('(max-width: 720px)').matches) return;
			const top = element.parentElement.getBoundingClientRect().top;
			element.style.maxHeight = `${Math.max(0, Math.min(560, top - (window.visualViewport?.offsetTop ?? 0) - 16))}px`;
		};
		resize();
		window.addEventListener('resize', resize);
		window.visualViewport?.addEventListener('resize', resize);
		window.visualViewport?.addEventListener('scroll', resize);
		return () => {
			window.removeEventListener('resize', resize);
			window.visualViewport?.removeEventListener('resize', resize);
			window.visualViewport?.removeEventListener('scroll', resize);
		};
	}, []);
	const pick = (ref?: string) => {
		if (ref) remember(withoutEffort(ref));
		onPick(ref);
	};
	const needle = query.trim().toLowerCase();
	const matches = (group: ModelGroup, model: ModelInfo) =>
		wanted.every((w) => (w === 'free' ? model.free : !!model[w])) &&
		(!needle ||
			group.name.toLowerCase().includes(needle) ||
			group.provider.toLowerCase().includes(needle) ||
			model.id.toLowerCase().includes(needle) ||
			(model.name ?? '').toLowerCase().includes(needle));
	const visible = groups
		?.filter((group) => !provider || group.provider === provider)
		.map((group) => ({ ...group, models: group.models.filter((model) => matches(group, model)) }))
		.filter((group) => group.models.length > 0 || group.error);
	const entries: Entry[] = (groups ?? []).flatMap((group) => group.models.map((model) => ({ group, model, ref: refOf(group.provider, model) })));
	const chosen = current ? withoutEffort(current) : undefined;
	const currentEntry = chosen ? entries.find((e) => e.ref === chosen) : undefined;
	const effort = current && chosen && current !== chosen ? current.slice(chosen.length + 1) : '';
	const defaultEntry = defaultModel ? entries.find((e) => e.ref === withoutEffort(defaultModel)) : undefined;
	const filtering = !!needle || wanted.length > 0 || !!provider;
	const recentEntries = filtering ? [] : recent.map((ref) => entries.find((e) => e.ref === ref)).filter((e): e is Entry => !!e);
	const shown = active ?? currentEntry;
	const toggle = (key: Capability) => setWanted((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
	const row = (entry: Entry, sub?: string) => (
		<ModelRow key={entry.ref} entry={entry} sub={sub} current={entry.ref === chosen} onPick={() => pick(entry.ref)} onActive={() => setActive(entry)} />
	);
	return (
		<DialogContent
			ref={panel}
			className="model-picker"
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				panel.current?.querySelector<HTMLInputElement>('.model-search')?.focus();
			}}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
				const target = event.target as HTMLElement;
				if (!target.matches('.model-search, .model-choice')) return;
				const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.model-choice:not(:disabled)')].filter((button) => !button.closest('details:not([open])'));
				if (!choices.length) return;
				event.preventDefault();
				const index = choices.indexOf(target as HTMLButtonElement);
				const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
				choices[next].focus();
				choices[next].scrollIntoView?.({ block: 'nearest' });
			}}
		>
			<DialogTitle className="sr-only">Choose a model</DialogTitle>
			<DialogDescription className="sr-only">Switch the model for this conversation's next replies, or follow your default.</DialogDescription>
			<span className="model-grab" aria-hidden="true" />
			<div className="model-head">
				<label className="model-search-row">
					<SearchIcon />
					<input
						className="model-search"
						aria-label="Search models"
						placeholder="Search models…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== 'Enter') return;
							event.preventDefault();
							if (event.nativeEvent.isComposing || !needle) return;
							const choices = panel.current?.querySelectorAll<HTMLButtonElement>('.model-group .model-choice:not(:disabled)') ?? [];
							[...choices].find((button) => !button.closest('details:not([open])'))?.click();
						}}
					/>
				</label>
				<div className="model-chips" role="group" aria-label="Show only">
					{capabilityFilters.map((f) => (
						<button key={f.key} type="button" className="model-chip" aria-pressed={wanted.includes(f.key)} onClick={() => toggle(f.key)}>
							{f.icon}
							{f.label}
						</button>
					))}
					{groups && groups.length > 1 && (
						<select className="model-chip model-provider-filter" aria-label="Provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
							<option value="">All providers</option>
							{groups.map((group) => (
								<option key={group.provider} value={group.provider}>
									{group.name || group.provider}
								</option>
							))}
						</select>
					)}
				</div>
			</div>
			<div className="model-results" onMouseLeave={() => setActive(undefined)}>
				{error && <Notice tone="error" size="sm" className="model-error">{error}</Notice>}
				{!groups && !error && (
					<p className="muted model-note" role="status">
						Loading models…
					</p>
				)}
				{groups && !filtering && (
					<Button
						type="button"
						variant="ghost"
						className="model-choice follow-default"
						title={defaultModel ? `Default: ${defaultModel}` : 'Use the default model for new conversations'}
						aria-current={current ? undefined : 'true'}
						onClick={() => pick(undefined)}
						onFocus={() => setActive(undefined)}
					>
						<span className="model-name">
							Follow the default
							{defaultModel && <small className="model-sub">{defaultEntry?.model.name || defaultModel}</small>}
						</span>
						<span className="model-check">{!current && <CheckIcon />}</span>
					</Button>
				)}
				{recentEntries.length > 0 && (
					<section className="model-recent" aria-label="Recent">
						<h3>Recent</h3>
						<ul>{recentEntries.map((e) => row(e, e.group.name || e.group.provider))}</ul>
					</section>
				)}
				{visible?.map((group) => {
					const brand = modelBrand(group.provider, '');
					return (
						<section className="model-group" key={group.provider} aria-label={group.name || group.provider}>
							<h3>
								{brand && <BrandIcon brand={brand} size={12} />}
								{group.name || group.provider}
								{group.models.length > 0 && <span className="model-count">{group.models.length}</span>}
							</h3>
							{group.error && (
								<Notice tone="error" size="sm" className="model-error">
									<span title={group.error}>{group.error}</span>
								</Notice>
							)}
							{families(group.provider, group.models).map((family) => {
								const list = <ul>{family.models.map((model) => row({ group, model, ref: refOf(group.provider, model) }))}</ul>;
								if (!family.prefix || group.models.length <= foldAbove) return <div key={family.prefix}>{list}</div>;
								const open = !!needle || wanted.length > 0 || family.models.some((m) => refOf(group.provider, m) === chosen);
								return (
									<details className="model-family" key={family.prefix} open={open}>
										<summary>
											{family.prefix}
											<span className="model-count">{family.models.length}</span>
										</summary>
										{list}
									</details>
								);
							})}
						</section>
					);
				})}
				{visible && visible.length === 0 && (
					<p className="muted model-note">
						{groups?.length === 0
							? 'No model provider is set up yet. Add one to choose from its models.'
							: wanted.length === 1 && wanted[0] === 'free' && !needle
								? 'No free models. OpenRouter lists free ones with names ending in :free.'
								: `No ${wanted.includes('free') ? 'free ' : ''}models match${needle ? ` “${query.trim()}”` : ' these filters'}.`}
					</p>
				)}
			</div>
			{shown && <ModelCard entry={shown} />}
			{currentEntry?.model.efforts?.length ? (
				<div className="model-effort">
					<span id="model-effort-label">
						<BrainIcon /> Reasoning
					</span>
					<div className="model-segments" role="group" aria-labelledby="model-effort-label">
						{['', ...currentEntry.model.efforts].map((level) => (
							<button
								key={level || 'default'}
								type="button"
								aria-pressed={effort === level}
								onClick={() => pick(level ? `${currentEntry.ref}:${level}` : currentEntry.ref)}
							>
								{level || 'Default'}
							</button>
						))}
					</div>
				</div>
			) : null}
			{(addProvider || (setDefault && chosen)) && (
				<div className="model-picker-footer">
					{setDefault && current && defaultModel !== current ? (
						<Button type="button" variant="ghost" className="model-set-default" onClick={() => setDefault(current)}>
							Make {[currentEntry?.model.name || chosen, effort].filter(Boolean).join(' ')} the default
						</Button>
					) : (
						defaultModel && (
							<span className="model-default">
								Default: {defaultEntry ? [defaultEntry.model.name, defaultModel.slice(defaultEntry.ref.length + 1)].filter(Boolean).join(' ') : defaultModel}
							</span>
						)
					)}
					{addProvider && (
						<Button type="button" variant={groups?.length === 0 ? 'primary' : 'outline'} className="model-add-provider" onClick={addProvider}>
							<PlusIcon /> Add a model provider
						</Button>
					)}
				</div>
			)}
		</DialogContent>
	);
}

function ModelRow({ entry, sub, current, onPick, onActive }: { entry: Entry; sub?: string; current: boolean; onPick: () => void; onActive: () => void }) {
	const { model } = entry;
	const name = model.name || model.id;
	const brand = modelBrand(`${model.id} ${model.name ?? ''}`, '');
	return (
		<li className="model-row">
			<Button
				type="button"
				variant="ghost"
				className="model-choice"
				aria-label={name}
				aria-current={current ? 'true' : undefined}
				onClick={onPick}
				onMouseEnter={onActive}
				onFocus={onActive}
			>
				<span className="model-logo">{brand && <BrandIcon brand={brand} size={16} />}</span>
				<span className="model-name">
					{name}
					{sub && <small className="model-sub">{sub}</small>}
				</span>
				{model.free && <small className="model-free">Free</small>}
				<span className="model-caps" aria-hidden="true">
					{model.reasoning && <BrainIcon />}
					{model.vision && <EyeIcon />}
					{model.tools && <WrenchIcon />}
				</span>
				<span className="model-context">{model.context ? tokens(model.context) : ''}</span>
				<span className="model-check">{current && <CheckIcon />}</span>
			</Button>
		</li>
	);
}

// ModelCard says what the model under the pointer or focus can do, beside the list.
function ModelCard({ entry }: { entry: Entry }) {
	const { model, group, ref } = entry;
	const brand = modelBrand(`${model.id} ${model.name ?? ''}`, '');
	const rows: [string, string][] = [['Provider', group.name || group.provider]];
	if (model.context) rows.push(['Context', model.context.toLocaleString('en-US')]);
	if (model.output) rows.push(['Max output', model.output.toLocaleString('en-US')]);
	rows.push(['Reasoning', model.efforts?.length ? model.efforts.join(' · ') : model.reasoning ? 'yes' : 'no']);
	rows.push(['Input', model.vision ? 'text · images' : 'text']);
	rows.push(['Tools', model.tools ? 'yes' : 'no']);
	if (model.free) rows.push(['Price', 'free']);
	else if (model.cost) rows.push(['Price / 1M', `$${model.cost.input} in · $${model.cost.output} out`]);
	return (
		<aside className="model-card" aria-label={`About ${model.name || model.id}`}>
			<h4>
				{brand && <BrandIcon brand={brand} size={16} />}
				{model.name || model.id}
			</h4>
			<p className="model-card-id">{ref}</p>
			<dl>
				{rows.map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
		</aside>
	);
}
