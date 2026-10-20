import { useEffect, useState } from 'react';
import type { Connection } from './api';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { cloud, newKey } from './remote';

type Runner = { id: string; session: string | null };
const storageKey = (id: string) => `mob-runner-key:${id}`;
// The Render Blueprint is render.yaml at the root of this repository.
export const renderDeployURL = 'https://render.com/deploy?repo=https://github.com/fdkevin0/mob';
const renderGuideURL = 'https://github.com/fdkevin0/mob/blob/main/docs/features/remote-access.md#runner-on-render';

/** Runners lists the account's runners and pairs new ones; deploy pairs one that Render runs instead of the user's computer. */
export function Runners({ connect, deploy }: { connect: (connection: Connection) => void; deploy?: boolean }) {
	const [runners, setRunners] = useState<Runner[]>([]);
	const [pairing, setPairing] = useState<{ id: string; json: string; expiresAt?: number }>();
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
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
			<h2>{deploy ? 'Deploy to Render' : 'Your runners'}</h2>
			{deploy ? (
				<p>
					Run Mob in your own Render account on a free web service. Messages and tool results are encrypted between this browser and the
					runner. A free instance has no disk, so conversations and added providers reset whenever Render restarts it; to keep them, upgrade
					it to a paid instance with a disk (about $7.25 a month, billed by Render;{' '}
					<a href={renderGuideURL} target="_blank" rel="noopener noreferrer">
						how to upgrade
					</a>
					).
				</p>
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
				{deploy ? 'Create Render pairing' : 'Pair a runner'}
			</Button>
			{pairing && (
				<div>
					{deploy ? (
						<p>
							Copy this private pairing JSON, then choose <strong>Deploy to Render</strong> and paste it as <code>MOB_RUNNER_PAIRING</code>. The
							runner appears here once Render has built and started it; then choose <strong>Open runner</strong>.
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
					{deploy && (
						<Button asChild>
							<a href={renderDeployURL} target="_blank" rel="noopener noreferrer">
								Deploy to Render
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
