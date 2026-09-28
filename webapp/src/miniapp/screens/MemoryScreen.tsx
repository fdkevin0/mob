import { notify } from '../mobile-ui';
import { useRef, useState } from 'react';
import { Button, List } from '../ui';
import type { MemoryFactPayload } from '../../../../src/features/miniapp/contract';
import { useAsyncResource } from '../../shared/useAsyncResource';
import { api } from '../api';
import { ResourceState } from '../ResourceState';

function day(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

function FactList({ title, facts }: { title: string; facts: MemoryFactPayload[] }) {
	if (!facts.length) return null;
	return <List header={<h2>{title} ({facts.length})</h2>}>
		{facts.map((fact) => <List.Item key={fact.id} description={<>
			{day(fact.ts)}{fact.lastSeenTs > fact.ts && ` · Seen ${day(fact.lastSeenTs)}`}
			{fact.layer === 'working' && ` · ×${fact.confirmations}`}
		</>}><p className="select-text whitespace-pre-wrap">{fact.text}</p></List.Item>)}
	</List>;
}

export function MemoryScreen() {
	const [forgetting, setForgetting] = useState(false);
	const confirmation = useRef<HTMLDialogElement>(null);
	const { data, reload, setData, loading, error } = useAsyncResource(api.listMemories, 'Could not load memory');
	const facts = data?.memories ?? [];
	const forgetAll = async () => {
		if (forgetting) return;
		confirmation.current?.close();
		setForgetting(true);
		try {
			const result = await api.forgetMemories();
			setData({ memories: [] });
			notify(result.count ? 'Memories cleared' : 'No memories to clear');
		} catch { notify('Could not clear memories'); }
		finally { setForgetting(false); }
	};
	return <div className="p-4">
		<header className="mb-4 flex items-center justify-between gap-3">
			<h1 className="text-xl leading-tight font-semibold wrap-anywhere">Memory</h1>
			<Button variant="plain" loading={loading} disabled={forgetting} aria-label="Refresh memory" onClick={reload}>Refresh</Button>
		</header>
		<dialog ref={confirmation} aria-labelledby="forget-title" aria-describedby="forget-description"
			className="fixed inset-4 m-auto w-auto max-w-sm rounded-2xl border border-separator bg-surface p-6 text-foreground shadow-xl backdrop:bg-black/40">
			<h2 id="forget-title" className="text-lg font-semibold">Forget all memories?</h2>
			<p id="forget-description" className="mt-2 text-sm text-muted">This cannot be undone.</p>
			<div className="mt-6 flex justify-end gap-3">
				<Button autoFocus onClick={() => confirmation.current?.close()}>Cancel</Button>
				<Button variant="danger" onClick={forgetAll}>Forget all</Button>
			</div>
		</dialog>
		<ResourceState loading={loading && !data} error={error} retry={reload} />
		{data && <>
			{!facts.length && <p className="text-muted">No memories yet</p>}
			<FactList title="Knowledge" facts={facts.filter((f) => f.layer === 'knowledge')} />
			<FactList title="Working memory" facts={facts.filter((f) => f.layer === 'working')} />
			{!!facts.length && <div className="mt-3 mb-5"><Button className="w-full" variant="danger" disabled={loading} loading={forgetting} onClick={() => confirmation.current?.showModal()}>Forget all</Button></div>}
		</>}
	</div>;
}
