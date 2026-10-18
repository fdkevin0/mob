import { useEffect, useState } from 'react';
import { api, type Connection } from './api';

export type ModelInfo = {
	id: string;
	name?: string;
	context?: number;
	output?: number;
	reasoning?: boolean;
	tools: boolean;
	vision?: boolean;
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

/**
 * ModelPicker offers the models of every configured provider for this conversation.
 * It reuses the /model command: choosing a model is the same switch a typed command makes.
 */
export function ModelPicker({
	connection,
	current,
	defaultModel,
	onPick,
	onClose,
}: {
	connection: Connection;
	current?: string;
	defaultModel?: string;
	onPick: (model?: string) => void;
	onClose: () => void;
}) {
	const [groups, setGroups] = useState<ModelGroup[]>();
	const [error, setError] = useState('');
	const [query, setQuery] = useState('');
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
	useEffect(() => {
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', escape);
		return () => window.removeEventListener('keydown', escape);
	}, [onClose]);
	const needle = query.trim().toLowerCase();
	const visible = groups
		?.map(group => ({
			...group,
			models: group.models.filter(
				model =>
					!needle ||
					group.name.toLowerCase().includes(needle) ||
					group.provider.toLowerCase().includes(needle) ||
					model.id.toLowerCase().includes(needle) ||
					(model.name ?? '').toLowerCase().includes(needle),
			),
		}))
		.filter(group => group.models.length > 0);
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<section role="dialog" aria-modal="true" aria-label="Choose a model" className="model-picker" onClick={event => event.stopPropagation()}>
				<header>
					<h2>Choose a model</h2>
					<button className="plain" onClick={onClose}>
						Close
					</button>
				</header>
				<input
					className="model-search"
					aria-label="Search models"
					placeholder="Search providers and models…"
					autoFocus
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>
				{error && <p role="alert">{error}</p>}
				{!groups && !error && <p className="muted" role="status">Loading models…</p>}
				{groups && (
					<button className="model-choice follow-default" aria-current={current ? undefined : 'true'} onClick={() => onPick(undefined)}>
						<span>Follow the default{defaultModel ? ` (${defaultModel})` : ''}</span>
						<span className="model-meta">New conversations and ones without their own model use it</span>
					</button>
				)}
				{visible?.map(group => (
					<section className="model-group" key={group.provider} aria-label={group.name || group.provider}>
						<h3>{group.name || group.provider}</h3>
						{group.error && <p className="muted">{group.error}</p>}
						<ul>
							{group.models.map(model => (
								<li key={model.id}>
									<button className="model-choice" aria-current={model.id === current ? 'true' : undefined} onClick={() => onPick(model.id)}>
										<span>{model.name || model.id}</span>
										<span className="model-id">{model.id}</span>
										<span className="model-meta">{capabilities(model)}</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				))}
				{visible && visible.length === 0 && <p className="muted">No models match “{query.trim()}”.</p>}
			</section>
		</div>
	);
}
