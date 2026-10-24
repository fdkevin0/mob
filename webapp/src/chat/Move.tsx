import { useEffect, useState } from 'react';
import { webClient, type Connection, type Conversation } from './api';
import { browserConnection } from './browser/connection';
import { cloud } from './remote';
import { runnerConnection } from './Runners';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';

type Target = { id: string; label: string; connection: Connection };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// targets are the other Mobs this browser can reach: itself, the runners it paired, and Mob on this computer.
async function targets(current: Connection): Promise<Target[]> {
	const out: Target[] = [];
	if (!current.browser) out.push({ id: 'browser', label: 'This browser', connection: browserConnection() });
	try {
		for (const r of await cloud<{ id: string; session: string | null }[]>('')) {
			const connection = r.id === current.runner?.id ? undefined : runnerConnection(r.id);
			if (connection) out.push({ id: 'runner:' + r.id, label: `Runner ${r.id.slice(0, 8)}${r.session ? '' : ' (offline)'}`, connection });
		}
	} catch { /* without the account's runners, the others are still offered */ }
	let token: string | null = null, url: string | null = null;
	try { token = localStorage.getItem('mob-token'); url = localStorage.getItem('mob-url'); } catch { /* no saved local Mob */ }
	if (token && url && (current.browser || current.runner || current.url !== url)) out.push({ id: 'local', label: `Mob on this computer (${url})`, connection: { url, token } });
	return out;
}

/**
 * Move copies conversations to another Mob, such as from this browser to a
 * runner where coding agents can pick them up, or back. The originals stay.
 */
export function Move({ connection, conversations, selected, onSwitch }: { connection: Connection; conversations: Conversation[]; selected?: string; onSwitch: (connection: Connection) => void }) {
	const [options, setOptions] = useState<Target[]>();
	const [target, setTarget] = useState('');
	const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected ? [selected] : []));
	const [busy, setBusy] = useState(false);
	const [results, setResults] = useState<{ title: string; error?: string }[]>();
	useEffect(() => {
		let live = true;
		void targets(connection).then(t => { if (live) { setOptions(t); setTarget(t[0]?.id ?? ''); } });
		return () => { live = false; };
	}, [connection]);
	const to = options?.find(t => t.id === target);
	async function move() {
		if (!to) return;
		setBusy(true); setResults(undefined);
		const from = webClient(connection), into = webClient(to.connection);
		const done: { title: string; error?: string }[] = [];
		for (const c of conversations.filter(c => chosen.has(c.id))) {
			try { await into.importConversation(await from.exportConversation(c.id)); done.push({ title: c.title }); }
			catch (e) { done.push({ title: c.title, error: errorText(e) }); }
			setResults([...done]);
		}
		setBusy(false);
	}
	const toggle = (id: string) => setChosen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
	return (
		<DialogContent className="connect-dialog move-dialog">
			<DialogTitle className="dialog-title">Move conversations</DialogTitle>
			<DialogDescription className="dialog-description">
				Copy conversations to another Mob, with their messages, summary, saved facts and token usage. The originals stay here. Pending approvals, tasks and schedules do not move.
			</DialogDescription>
			{!options && <p className="muted" role="status">Looking for other Mobs…</p>}
			{options && !options.length && <p>There is no other Mob to move to yet. Pair a runner or connect Mob on this computer first.</p>}
			{options && options.length > 0 && (
				<fieldset disabled={busy} className="provider-form">
					<Label htmlFor="move-target">Move to</Label>
					<select id="move-target" value={target} onChange={e => setTarget(e.target.value)}>
						{options.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
					</select>
					<ul className="move-list" aria-label="Conversations">
						{conversations.map(c => (
							<li key={c.id}>
								<label><input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} /> {c.title}</label>
							</li>
						))}
					</ul>
					<div className="browser-limits-actions">
						<Button onClick={() => void move()} disabled={!chosen.size || !to}>{busy ? 'Moving…' : `Copy ${chosen.size || ''} to ${to?.label ?? '…'}`}</Button>
						<Button variant="ghost" type="button" onClick={() => setChosen(chosen.size === conversations.length ? new Set() : new Set(conversations.map(c => c.id)))}>
							{chosen.size === conversations.length ? 'Choose none' : 'Choose all'}
						</Button>
					</div>
				</fieldset>
			)}
			{results && (
				<ul className="move-results" role="status">
					{results.map((r, i) => <li key={i}>{r.error ? `${r.title}: ${r.error}` : `${r.title}: copied`}</li>)}
				</ul>
			)}
			{results && !busy && to && results.some(r => !r.error) && <Button variant="outline" onClick={() => onSwitch(to.connection)}>Open {to.label}</Button>}
		</DialogContent>
	);
}
