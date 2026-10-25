import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Connection } from './api';
import { Content as DialogContent } from '@radix-ui/react-dialog';
import { DialogDescription, DialogTitle } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { PlusIcon } from './icons';

export type ModelInfo = {
	id: string;
	name?: string;
	context?: number;
	output?: number;
	reasoning?: boolean;
	tools: boolean;
	vision?: boolean;
	/** free is set for a model that costs nothing to call, such as OpenRouter's `:free` variants. */
	free?: boolean;
};

export type ModelGroup = {
	provider: string;
	name: string;
	models: ModelInfo[];
	error?: string;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// formatContext keeps capability hints short: 131072 becomes 131k.
function formatContext(tokens: number) {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function capabilities(model: ModelInfo) {
	const parts = [model.tools ? 'tools' : 'no tools'];
	if (model.reasoning) parts.push('reasoning');
	if (model.vision) parts.push('vision');
	if (model.context) parts.push(`${formatContext(model.context)} context`);
	return parts.join(' · ');
}

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

/**
 * ModelPicker offers the models of every configured provider for this conversation.
 * Choosing one changes the conversation's model setting, as /model does; neither adds to the transcript.
 */
export function ModelPicker({
	connection,
	current,
	defaultModel,
	onPick,
	disabled = false,
	addProvider,
}: {
	connection: Connection;
	current?: string;
	defaultModel?: string;
	onPick: (model?: string) => void;
	disabled?: boolean;
	/** addProvider opens the Model provider dialog, for models the configured providers do not offer. */
	addProvider?: () => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [groups, setGroups] = useState<ModelGroup[]>();
	const [error, setError] = useState('');
	const [query, setQuery] = useState('');
	const [freeOnly, setFreeOnly] = useState(false);
	const [provider, setProvider] = useState('');
	useEffect(() => {
		let live = true;
		api<ModelGroup[]>(connection, '/models')
			.then(next => {
				if (live) setGroups(next);
			})
			.catch(e => {
				if (live) setError(errorText(e));
			});
		return () => {
			live = false;
		};
	}, [connection]);
	useLayoutEffect(() => {
		const resize = () => {
			const element = panel.current;
			if (!element?.parentElement) return;
			const top = element.parentElement.getBoundingClientRect().top;
			element.style.maxHeight = `${Math.max(0, Math.min(360, top - (window.visualViewport?.offsetTop ?? 0) - 16))}px`;
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
	const needle = query.trim().toLowerCase();
	const visible = groups
		?.filter(group => !provider || group.provider === provider)
		.map(group => ({
			...group,
			models: group.models.filter(
				model =>
					(!freeOnly || model.free) &&
					(!needle ||
					group.name.toLowerCase().includes(needle) ||
					group.provider.toLowerCase().includes(needle) ||
					model.id.toLowerCase().includes(needle) ||
					(model.name ?? '').toLowerCase().includes(needle)),
			),
		}))
		.filter(group => group.models.length > 0 || group.error);
	return (
		<DialogContent ref={panel} className="model-picker" onKeyDown={event => {
			if (event.nativeEvent.isComposing || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
			const target = event.target as HTMLElement;
			if (!target.matches('.model-search, .model-choice')) return;
			const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.model-choice:not(:disabled)')]
				.filter(button => !button.closest('details:not([open])'));
			if (!choices.length) return;
			event.preventDefault();
			const index = choices.indexOf(target as HTMLButtonElement);
			const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1)
				: (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
			choices[next].focus();
			choices[next].scrollIntoView?.({ block: 'nearest' });
		}}>
			<DialogTitle className="sr-only">Choose a model</DialogTitle>
			<DialogDescription className="sr-only">Switch the model for this conversation, or follow your default.</DialogDescription>
			<div className="model-filters">
				<Input
					className="model-search"
					aria-label="Search models"
					placeholder="Search models…"
					autoFocus
					value={query}
					onChange={event => setQuery(event.target.value)}
					onKeyDown={event => {
						if (event.key === 'Enter') {
							event.preventDefault();
							if (!event.nativeEvent.isComposing && needle) {
								const choices = panel.current?.querySelectorAll<HTMLButtonElement>('.model-group .model-choice:not(:disabled)') ?? [];
								[...choices].find(button => !button.closest('details:not([open])'))?.click();
							}
						}
					}}
				/>
				<Button type="button" variant="ghost" className="model-filter-toggle" aria-label="Filters" aria-expanded={filtersOpen} aria-pressed={!!provider || freeOnly} onClick={() => setFiltersOpen(open => !open)}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16M9 4v6M15 14v6" /></svg>
				</Button>
			</div>
			<div className="model-results">
				{disabled && <p role="status">Wait for the current turn to finish before switching models.</p>}
				{filtersOpen && <div className="model-filter-options">
					<label>Provider
						<select aria-label="Provider" value={provider} onChange={event => setProvider(event.target.value)}>
							<option value="">All providers</option>
							{groups?.map(group => <option key={group.provider} value={group.provider}>{group.name || group.provider}</option>)}
						</select>
					</label>
					<label><input type="checkbox" checked={freeOnly} onChange={event => setFreeOnly(event.target.checked)} /> Free only</label>
				</div>}
				{error && <p role="alert">{error}</p>}
				{!groups && !error && <p className="muted" role="status">Loading models…</p>}
				{groups && (
					<Button type="button" variant="ghost" disabled={disabled} className="model-choice follow-default" title={defaultModel ? `Default: ${defaultModel}` : 'Use the default model for new conversations'} aria-current={current ? undefined : 'true'} onClick={() => onPick(undefined)}>
						<span className="model-name">Follow the default</span>
						<span aria-hidden="true">{!current ? '✓' : ''}</span>
					</Button>
				)}
				{visible?.map(group => (
					<section className="model-group" key={group.provider} aria-label={group.name || group.provider}>
						<h3>{group.name || group.provider}</h3>
						{group.error && <p className="muted" role="alert">{group.error}</p>}
						{families(group.provider, group.models).map(family => {
							const list = <ModelList models={family.models} current={current} onPick={onPick} disabled={disabled} />;
							if (!family.prefix || group.models.length <= foldAbove) return <div key={family.prefix}>{list}</div>;
							const open = !!needle || freeOnly || group.models.length <= foldAbove || family.models.some(m => m.id === current);
							return (
								<details className="model-family" key={family.prefix} open={open}>
									<summary>{family.prefix}<span className="model-count">{family.models.length}</span></summary>
									{list}
								</details>
							);
						})}
					</section>
				))}
				{visible && visible.length === 0 && (
					<p className="muted">
						{groups?.length === 0
							? 'No model provider is set up yet. Add one to choose from its models.'
							: freeOnly && !needle
								? 'No free models. OpenRouter lists free ones with names ending in :free.'
								: `No ${freeOnly ? 'free ' : ''}models match “${query.trim()}”.`}
					</p>
				)}
			</div>
			{addProvider && (
				<div className="model-picker-footer">
					<Button type="button" variant={groups?.length === 0 ? 'primary' : 'outline'} className="model-add-provider" onClick={addProvider}>
						<PlusIcon /> Add a model provider
					</Button>
				</div>
			)}
		</DialogContent>
	);
}

function ModelList({ models, current, onPick, disabled }: { models: ModelInfo[]; current?: string; onPick: (model?: string) => void; disabled: boolean }) {
	return (
		<ul>
			{models.map(model => (
				<li key={model.id} className="model-row">
					<Button type="button" variant="ghost" disabled={disabled} className="model-choice" title={model.name || model.id} aria-current={model.id === current ? 'true' : undefined} onClick={() => onPick(model.id)}>
						<span className="model-name">{model.name || model.id}</span>
						{model.free && <small className="model-free">Free</small>}
						<span className="model-check" aria-hidden="true">{model.id === current ? '✓' : ''}</span>
					</Button>
					<details className="model-details">
						<summary aria-label={`Details for ${model.name || model.id}`}>ⓘ</summary>
						<div><span className="model-id">{model.id}</span><span className="model-meta">{capabilities(model)}</span></div>
					</details>
				</li>
			))}
		</ul>
	);
}
