import { useEffect, useState } from 'react';
import { Button } from '@mob/ui/button';
import { Notice } from '@mob/ui/notice';

type Installation = { id: number; account: string; type: string; runner: string | null; suspended: boolean };
type State = { app: string | null; github: boolean; installations: Installation[] };

const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
	const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
	const body = await response.json().catch(() => ({})) as T & { error?: string };
	if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
	return body;
};

// The GitHub section: install the Mob GitHub App on an account or
// organization, then pick which runner hears its events. Only installations
// on the visitor's GitHub account, or that they installed, are listed.
export function GitHubApp() {
	const [state, setState] = useState<State>();
	const [runners, setRunners] = useState<string[]>([]);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState<number>();
	function load() {
		request<State>('/api/github/installations').then(setState).catch(e => setError((e as Error).message));
		request<{ id: string }[]>('/api/runners').then(list => setRunners(list.map(r => r.id))).catch(() => setRunners([]));
	}
	useEffect(load, []);
	async function bind(installation: Installation, runner: string) {
		setBusy(installation.id); setError('');
		try {
			await request(`/api/github/installations/${installation.id}`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runner: runner || null }),
			});
			load();
		} catch (e) { setError((e as Error).message); }
		setBusy(undefined);
	}
	if (state && !state.app) return null;
	return (
		<section className="account-card" id="github" aria-labelledby="github-title">
			<h2 id="github-title">GitHub</h2>
			<p className="account-muted">Install the Mob GitHub App on a repository, then choose the runner that watches it. Label an issue <code>mob</code> and Mob proposes a plan there for you to approve. GitHub sends usemob.app only which issue changed and who changed it; your runner reads the issue itself.</p>
			{error ? <Notice tone="error">{error}</Notice> : null}
			{!state ? (error ? null : <p className="account-muted">Loading…</p>) : (
				<>
					{!state.github ? <Notice tone="warning" role="note">Connect GitHub under Sign-in methods to see the installations you made.</Notice> : null}
					{state.installations.length ? (
						<ul className="account-list">
							{state.installations.map(i => (
								<li key={i.id}>
									<span className="account-item-name">{i.account}</span>
									<span className="account-muted">{i.suspended ? 'Suspended on GitHub' : i.type === 'Organization' ? 'Organization' : 'Personal account'}</span>
									<span className="account-item-actions">
										<select className="ui-input" aria-label={`Runner for ${i.account}`} value={i.runner ?? ''} disabled={busy === i.id} onChange={e => void bind(i, e.target.value)}>
											<option value="">No runner</option>
											{runners.map(id => <option key={id} value={id}>Runner {id.slice(0, 8)}</option>)}
										</select>
									</span>
								</li>
							))}
						</ul>
					) : <p className="account-empty">Not installed yet.</p>}
					{state.installations.length && !runners.length ? <p className="account-muted">Pair a runner in Mob on the web first; events wait for it for up to a week.</p> : null}
					<div className="account-add">
						<Button type="button" variant="outline" onClick={() => window.location.assign(`https://github.com/apps/${state.app}/installations/new`)}>Install on GitHub</Button>
					</div>
				</>
			)}
		</section>
	);
}
