import { useEffect, useState } from 'react';
import { api, type Connection } from './api';
import { DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

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
 * It reuses the /model command: choosing a model is the same switch a typed command makes.
 */
export function ModelPicker({
	connection,
	current,
	defaultModel,
	onPick,
}: {
	connection: Connection;
	current?: string;
	defaultModel?: string;
	onPick: (model?: string) => void;
}) {
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
		.filter(group => group.models.length > 0);
	return (
		<DialogContent className="model-picker">
			<DialogTitle className="dialog-title">Choose a model</DialogTitle>
			<DialogDescription className="dialog-description">Switch the model for this conversation, or follow your default.</DialogDescription>
			<div className="model-filters">
				<Input
					className="model-search"
					aria-label="Search models"
					placeholder="Search providers and models…"
					autoFocus
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>
				<Button variant="outline" className="model-free-filter" aria-pressed={freeOnly} onClick={() => setFreeOnly(on => !on)}>
					Free only{groups ? ` (${groups.reduce((n, g) => n + g.models.filter(m => m.free).length, 0)})` : ''}
				</Button>
			</div>
			{groups && groups.length > 1 && (
				<div className="model-providers" role="group" aria-label="Providers">
					{[{ provider: '', name: 'All' }, ...groups].map(g => (
						<Button key={g.provider} variant="outline" className="model-provider" aria-pressed={provider === g.provider} onClick={() => setProvider(g.provider)}>
							{g.name || g.provider}
						</Button>
					))}
				</div>
			)}
			{error && <p role="alert">{error}</p>}
			{!groups && !error && <p className="muted" role="status">Loading models…</p>}
			{groups && (
				<Button variant="ghost" className="model-choice follow-default" aria-current={current ? undefined : 'true'} onClick={() => onPick(undefined)}>
					<span>Follow the default{defaultModel ? ` (${defaultModel})` : ''}</span>
					<span className="model-meta">New conversations and ones without their own model use it</span>
				</Button>
			)}
			{visible?.map(group => (
				<section className="model-group" key={group.provider} aria-label={group.name || group.provider}>
					<h3>{group.name || group.provider}</h3>
					{group.error && <p className="muted">{group.error}</p>}
					{families(group.provider, group.models).map(family => {
						const list = <ModelList models={family.models} current={current} onPick={onPick} />;
						if (!family.prefix) return <div key="">{list}</div>;
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
				<p className="muted">{freeOnly && !needle ? 'No free models. OpenRouter lists free ones with names ending in :free.' : `No ${freeOnly ? 'free ' : ''}models match “${query.trim()}”.`}</p>
			)}
		</DialogContent>
	);
}

function ModelList({ models, current, onPick }: { models: ModelInfo[]; current?: string; onPick: (model?: string) => void }) {
	return (
		<ul>
			{models.map(model => (
				<li key={model.id}>
					<Button variant="ghost" className="model-choice" aria-current={model.id === current ? 'true' : undefined} onClick={() => onPick(model.id)}>
						<span>
							{model.name || model.id}
							{model.free && <small className="model-free">Free</small>}
						</span>
						<span className="model-id">{model.id}</span>
						<span className="model-meta">{capabilities(model)}</span>
					</Button>
				</li>
			))}
		</ul>
	);
}
