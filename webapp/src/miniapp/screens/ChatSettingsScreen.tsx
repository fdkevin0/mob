import { notify } from '../mobile-ui';
import { useState } from 'react';
import { Button, List } from '../ui';
import type { ChatSettingsDataResponse, ReasoningEffort } from '../../../../src/features/miniapp/contract';
import { api, REASONING_OPTIONS } from '../api';
import { useAsyncResource } from '../../shared/useAsyncResource';
import { ResourceState } from '../ResourceState';

export function ChatSettingsScreen() {
	const { data, loading, error, reload } = useAsyncResource(api.chatSettingsData, 'Could not load chat settings');
	return <div className="p-4">
		<h1 className="mb-4 text-xl leading-tight font-semibold wrap-anywhere">Chat settings</h1>
		<ResourceState loading={loading && !data} error={error} retry={reload} />
		{data && <ChatSettingsForm initial={data} />}
	</div>;
}

function ChatSettingsForm({ initial }: { initial: ChatSettingsDataResponse }) {
	const [reasoning, setReasoning] = useState(initial.reasoningEffort);
	const [compaction, setCompaction] = useState(String(initial.compactionThreshold));
	const [memory, setMemory] = useState(String(initial.memoryTopK));
	const [saving, setSaving] = useState<'reasoning' | 'compaction' | 'memory' | null>(null);

	const saveReasoning = async (effort: ReasoningEffort) => {
		if (saving) return;
		setSaving('reasoning');
		try {
			const res = await api.setChatReasoning(effort);
			setReasoning(res.reasoningEffort);
			notify('Reasoning saved');
		} catch { notify('Could not save reasoning'); }
		finally { setSaving(null); }
	};
	const saveCompaction = async () => {
		if (saving) return;
		setSaving('compaction');
		try {
			const res = await api.setChatCompaction(compaction.trim() === '' ? null : Number(compaction));
			setCompaction(String(res.compactionThreshold));
			notify('Threshold saved');
		} catch { notify('Could not save threshold'); }
		finally { setSaving(null); }
	};
	const saveMemory = async () => {
		if (saving) return;
		setSaving('memory');
		try {
			const res = await api.setChatMemoryTopK(memory.trim() === '' ? null : Number(memory));
			setMemory(String(res.memoryTopK));
			notify('Retrieval count saved');
		} catch { notify('Could not save retrieval count'); }
		finally { setSaving(null); }
	};

	return <>
		<List header={<label htmlFor="reasoning">Reasoning</label>}>
			<List.Item>
				<select className="min-h-11 w-full rounded-none border-0 bg-surface text-base disabled:opacity-50" id="reasoning" disabled={saving !== null} value={reasoning} onChange={(e) => void saveReasoning(e.target.value as ReasoningEffort)}>
					{REASONING_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.value === 'default' ? 'Automatic' : opt.label}</option>)}
				</select>
			</List.Item>
		</List>
		<form onSubmit={(event) => { event.preventDefault(); void saveCompaction(); }}>
			<List header={<label htmlFor="compaction">Compaction threshold</label>}>
				<List.Item description={<span id="compaction-help">Tokens before summarizing. Blank resets to default.</span>}>
					<input className="min-h-11 w-full rounded-none border-0 bg-surface text-base disabled:opacity-50" id="compaction" type="number" inputMode="numeric" enterKeyHint="done" min={1}
						aria-describedby="compaction-help" disabled={saving !== null} value={compaction} onChange={(e) => setCompaction(e.target.value)} />
				</List.Item>
			</List>
			<div className="mt-3 mb-5"><Button className="w-full" variant="primary" type="submit" loading={saving === 'compaction'} disabled={saving !== null} loadingText="Saving">Save threshold</Button></div>
		</form>
		<form onSubmit={(event) => { event.preventDefault(); void saveMemory(); }}>
			<List header={<label htmlFor="memory-count">Memory retrieval count</label>}>
				<List.Item description={<span id="memory-help">Facts recalled per reply. Blank resets to default.</span>}>
					<input className="min-h-11 w-full rounded-none border-0 bg-surface text-base disabled:opacity-50" id="memory-count" type="number" inputMode="numeric" enterKeyHint="done" min={1}
						aria-describedby="memory-help" disabled={saving !== null} value={memory} onChange={(e) => setMemory(e.target.value)} />
				</List.Item>
			</List>
			<div className="mt-3 mb-5"><Button className="w-full" variant="primary" type="submit" loading={saving === 'memory'} disabled={saving !== null} loadingText="Saving">Save retrieval count</Button></div>
		</form>
	</>;
}
