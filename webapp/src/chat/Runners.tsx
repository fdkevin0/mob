import { useEffect, useState } from 'react';
import type { Connection } from './api';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { cloud, newKey } from './remote';
import { hostGuideURL, hosts } from './hosts';

type Runner = { id: string; session: string | null };
const storageKey = (id: string) => `mob-runner-key:${id}`;

/** Runners lists the account's runners and pairs new ones; deploy pairs one that a cloud host runs instead of the user's computer. */
export function Runners({ connect, deploy }: { connect: (connection: Connection) => void; deploy?: boolean }) {
	const [runners, setRunners] = useState<Runner[]>([]);
	const [pairing, setPairing] = useState<{ id: string; json: string; expiresAt?: number }>();
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [hostID, setHostID] = useState(hosts[0].id);
	const host = hosts.find((h) => h.id === hostID) ?? hosts[0];
	async function refresh() {
		setRunners(await cloud<Runner[]>(''));
	}
	useEffect(() => {
		let live = true;
		const poll = () =>
			cloud<Runner[]>('')
				.then((rows) => {
					if (live) setRunners(rows);
				})
				.catch((e) => {
					if (live) setError(String(e));
				});
		void poll();
		const timer = setInterval(poll, 5000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);
	async function pair() {
		setBusy(true);
		setError('');
		try {
			// Storage must work before creating a remote registration; keys are never recoverable from the server.
			const key = newKey();
			localStorage.setItem('mob-runner-storage-test', '1');
			localStorage.removeItem('mob-runner-storage-test');
			// A deployed runner gets its credential at once: a host without a disk forgets anything it claimed.
			const result = await cloud<{ id: string; code?: string; token?: string; expiresAt?: number }>('', {
				method: 'POST',
				...(deploy && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ for: 'deploy' }) }),
			});
			localStorage.setItem(storageKey(result.id), key);
			const secret = deploy ? { token: result.token } : { code: result.code };
			setPairing({
				id: result.id,
				expiresAt: result.expiresAt,
				json: JSON.stringify({ url: location.origin, id: result.id, ...secret, key }),
			});
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}
	async function revoke(id: string) {
		setBusy(true);
		setError('');
		try {
			await cloud(`/${id}`, { method: 'DELETE' });
			localStorage.removeItem(storageKey(id));
			if (pairing?.id === id) setPairing(undefined);
			await refresh();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}
	function open(id: string) {
		try {
			const key = localStorage.getItem(storageKey(id));
			if (!key) throw new Error('This browser has no key for this runner. Pair a new runner from this browser.');
			connect({ url: `${location.origin}/api/runners/${id}`, token: '', runner: { id, key } });
		} catch (e) {
			setError(String(e));
		}
	}
	return (
		<section aria-label="Remote runners">
			<h2>{deploy ? 'Deploy to the cloud' : 'Your runners'}</h2>
			{deploy ? (
				<>
					<p>
						Run Mob in your own account at a cloud host. Messages and tool results are encrypted between this browser and the runner;{' '}
						<a href={hostGuideURL} target="_blank" rel="noopener noreferrer">
							how it works
						</a>
						.
					</p>
					<div role="radiogroup" aria-label="Cloud host" className="host-choices">
						{hosts.map((h) => (
							<Button
								key={h.id}
								type="button"
								role="radio"
								aria-checked={h.id === host.id}
								variant={h.id === host.id ? 'primary' : 'outline'}
								disabled={!h.deployURL}
								onClick={() => setHostID(h.id)}
							>
								{h.name}
								{!h.deployURL && <small> Coming soon</small>}
							</Button>
						))}
					</div>
					<p>{host.summary}</p>
				</>
			) : (
				<p>Control Mob on another computer. Messages and tool results are encrypted between this browser and your runner.</p>
			)}
			{runners.map((runner) => (
				<div key={runner.id}>
					<span>
						Runner {runner.id.slice(0, 8)} · {runner.session ? 'Online' : 'Offline'}
					</span>{' '}
					<Button type="button" disabled={!runner.session || busy} onClick={() => open(runner.id)}>
						Open runner
					</Button>{' '}
					<Button type="button" disabled={busy} onClick={() => void revoke(runner.id)}>
						Revoke access
					</Button>
				</div>
			))}
			<Button type="button" disabled={busy} onClick={() => void pair()}>
				{deploy ? 'Create cloud pairing' : 'Pair a runner'}
			</Button>
			{pairing && (
				<div>
					{deploy ? (
						<p>
							Copy this private pairing JSON, then choose <strong>Deploy to {host.name}</strong> and paste it as <code>MOB_RUNNER_PAIRING</code>.
							The runner appears here once {host.name} has built and started it; then choose <strong>Open runner</strong>.
						</p>
					) : (
						<p>
							On your computer, run <code>mob runner pair</code> and paste this private pairing JSON. Then run <code>mob start</code> and{' '}
							<code>mob runner</code>.
						</p>
					)}
					<Label htmlFor="runner-pairing">
						Private pairing JSON{pairing.expiresAt ? ` (expires ${new Date(pairing.expiresAt).toLocaleTimeString()})` : ''}
					</Label>
					<Textarea id="runner-pairing" rows={5} spellCheck={false} readOnly value={pairing.json} onFocus={(e) => e.target.select()} />
					<p>
						Keep it private: it contains your encryption key{deploy && ' and the runner’s credential'}. This browser keeps the key locally;
						clearing site data loses access.
					</p>
					{deploy && host.deployURL && (
						<Button asChild>
							<a href={host.deployURL} target="_blank" rel="noopener noreferrer">
								Deploy to {host.name}
							</a>
						</Button>
					)}{' '}
					<Button type="button" onClick={() => setPairing(undefined)}>
						Hide pairing data
					</Button>
				</div>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
