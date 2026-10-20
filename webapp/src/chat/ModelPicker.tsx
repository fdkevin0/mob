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
}: {
	connection: Connection;
	current?: string;
	defaultModel?: string;
	onPick: (model?: string) => void;
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
		<DialogContent className="model-picker">
			<DialogTitle className="dialog-title">Choose a model</DialogTitle>
			<DialogDescription className="dialog-description">Switch the model for this conversation, or follow your default.</DialogDescription>
			<Input
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
				<Button variant="ghost" className="model-choice follow-default" aria-current={current ? undefined : 'true'} onClick={() => onPick(undefined)}>
					<span>Follow the default{defaultModel ? ` (${defaultModel})` : ''}</span>
					<span className="model-meta">New conversations and ones without their own model use it</span>
				</Button>
			)}
			{visible?.map(group => (
				<section className="model-group" key={group.provider} aria-label={group.name || group.provider}>
					<h3>{group.name || group.provider}</h3>
					{group.error && <p className="muted">{group.error}</p>}
					<ul>
						{group.models.map(model => (
							<li key={model.id}>
								<Button variant="ghost" className="model-choice" aria-current={model.id === current ? 'true' : undefined} onClick={() => onPick(model.id)}>
									<span>{model.name || model.id}</span>
									<span className="model-id">{model.id}</span>
									<span className="model-meta">{capabilities(model)}</span>
								</Button>
							</li>
						))}
					</ul>
				</section>
			))}
			{visible && visible.length === 0 && <p className="muted">No models match “{query.trim()}”.</p>}
		</DialogContent>
	);
}
