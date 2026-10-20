import { useEffect, useState, type FormEvent } from 'react';
import { authClient, errorCode } from '../landing/auth';
import { Logo } from '../components/brand/Logo';
import { PixelIcon } from '../components/brand/PixelIcon';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';

type Passkey = { id: string; name?: string | null; createdAt?: Date | string | null; backedUp: boolean; deviceType: string };
type Linked = { id: string; providerId: string; createdAt: Date | string };

const supported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window;
const day = (value?: Date | string | null) => value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// signInAgain ends the session and returns here through GitHub, which Better
// Auth asks for before a passkey is added to a session older than a day.
function signInAgain() {
	void authClient.signOut().finally(() => window.location.assign('/?signin=account'));
}

// The account page lists how the visitor signs in: the GitHub account that
// created it, and passkeys bound to that account.
export function Account() {
	const session = authClient.useSession();
	const user = session.data?.user;
	useEffect(() => {
		if (!session.isPending && !user && !session.error) window.location.assign('/?signin=account');
	}, [session.isPending, user, session.error]);

	if (session.isPending || !user) return (
		<div className="account-page"><Header /><main className="account-main">
			{session.error ? <p className="form-error" role="alert">Could not load your account. Check your connection and reload the page.</p> : <p className="account-muted">Loading…</p>}
		</main></div>
	);
	return (
		<div className="account-page">
			<Header />
			<main className="account-main">
				<h1>Account</h1>
				<section className="account-card account-profile" aria-label="Profile">
					<span className="avatar large">{user.image ? <img src={user.image} alt="" /> : (user.name || user.email).slice(0, 1).toUpperCase()}</span>
					<div><strong>{user.name}</strong><span>{user.email}</span></div>
				</section>
				<SignInMethods />
				<Passkeys />
			</main>
		</div>
	);
}

function Header() {
	return (
		<header className="account-nav">
			<a href="/" className="brand" aria-label="Mob home"><Logo /></a>
			<div className="account-nav-actions">
				<Button variant="outline" className="small" asChild><a href="/app">Open Mob</a></Button>
				<Button variant="ghost" className="small" onClick={() => { void authClient.signOut().finally(() => window.location.assign('/')); }}>Sign out</Button>
			</div>
		</header>
	);
}

function SignInMethods() {
	const [accounts, setAccounts] = useState<Linked[]>();
	const [error, setError] = useState('');
	useEffect(() => {
		authClient.listAccounts().then(result => {
			if (result.error) setError(result.error.message || 'Could not load sign-in methods.');
			else setAccounts(result.data as Linked[]);
		}).catch(e => setError(errorText(e)));
	}, []);
	const github = accounts?.find(account => account.providerId === 'github');
	return (
		<section className="account-card" aria-labelledby="methods-title">
			<h2 id="methods-title">Sign-in methods</h2>
			{error ? <p className="form-error" role="alert">{error}</p> : null}
			<ul className="account-list">
				<li>
					<span className="account-item-name">GitHub</span>
					<span className="account-muted">{accounts === undefined && !error ? 'Loading…' : github ? `Connected ${day(github.createdAt)}` : 'Not connected'}</span>
				</li>
			</ul>
			<p className="account-muted">GitHub created this account and stays connected. Passkeys below sign in to the same account.</p>
		</section>
	);
}

function Passkeys() {
	const list = authClient.useListPasskeys();
	const passkeys = (list.data ?? []) as Passkey[];
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [stale, setStale] = useState(false);
	const [notice, setNotice] = useState('');

	async function add(event: FormEvent) {
		event.preventDefault();
		setBusy(true); setError(''); setNotice(''); setStale(false);
		try {
			const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
			if (!result.error) { setName(''); setNotice('Passkey added. Use it from Sign in on the Mob home page.'); return; }
			const code = errorCode(result.error);
			if (code === 'SESSION_NOT_FRESH') { setStale(true); return; }
			setError(code === 'ERROR_CEREMONY_ABORTED' ? 'Adding the passkey was cancelled.'
				: code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' ? 'This passkey is already added to your account.'
				: result.error.message || 'The passkey was not added.');
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="account-card" aria-labelledby="passkeys-title">
			<h2 id="passkeys-title">Passkeys</h2>
			<p className="account-muted">Sign in with your fingerprint, face or device PIN instead of going through GitHub. Each passkey belongs to this account only.</p>
			{list.error ? <p className="form-error" role="alert">{list.error.message || 'Could not load passkeys.'}</p> : null}
			{list.isPending ? <p className="account-muted">Loading…</p> : passkeys.length === 0 ? <p className="account-empty">No passkeys yet.</p> : (
				<ul className="account-list">
					{passkeys.map(passkey => <PasskeyRow key={passkey.id} passkey={passkey} onError={setError} />)}
				</ul>
			)}
			{supported() ? (
				<form className="account-add" onSubmit={add}>
					<Label htmlFor="passkey-name">Name</Label>
					<div className="account-add-row">
						<Input id="passkey-name" value={name} maxLength={60} placeholder="Such as Work laptop" onChange={e => setName(e.target.value)} disabled={busy} />
						<Button disabled={busy}><PixelIcon name="key" size={12} />{busy ? 'Waiting for your device…' : 'Add a passkey'}</Button>
					</div>
				</form>
			) : <p className="form-error">This browser does not support passkeys.</p>}
			{stale ? (
				<div className="form-error" role="alert">
					For your safety, sign in with GitHub again before adding a passkey.{' '}
					<Button variant="outline" className="small" onClick={signInAgain}>Sign in again</Button>
				</div>
			) : null}
			{error ? <p className="form-error" role="alert">{error}</p> : null}
			{notice ? <p className="account-notice" role="status">{notice}</p> : null}
		</section>
	);
}

function PasskeyRow({ passkey, onError }: { passkey: Passkey; onError: (message: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(passkey.name ?? '');
	const [busy, setBusy] = useState(false);
	const label = passkey.name || 'Passkey';

	async function run(action: () => Promise<{ error: { message?: string } | null }>) {
		setBusy(true); onError('');
		try {
			const result = await action();
			if (result.error) onError(result.error.message || 'That did not work. Try again.');
			else setEditing(false);
		} catch (e) {
			onError(errorText(e));
		} finally {
			setBusy(false);
		}
	}
	function rename(event: FormEvent) {
		event.preventDefault();
		const next = name.trim();
		if (!next) return;
		void run(() => authClient.passkey.updatePasskey({ id: passkey.id, name: next }));
	}
	function remove() {
		if (!window.confirm(`Remove “${label}”? It will no longer sign in to Mob.`)) return;
		void run(() => authClient.passkey.deletePasskey({ id: passkey.id }));
	}

	if (editing) return (
		<li>
			<form className="account-add-row" onSubmit={rename}>
				<Input aria-label="Passkey name" value={name} maxLength={60} autoFocus onChange={e => setName(e.target.value)} disabled={busy} />
				<Button className="small" disabled={busy || !name.trim()}>Save</Button>
				<Button type="button" variant="ghost" className="small" onClick={() => { setEditing(false); setName(passkey.name ?? ''); }} disabled={busy}>Cancel</Button>
			</form>
		</li>
	);
	return (
		<li>
			<span className="account-item-name">{label}</span>
			<span className="account-muted">
				{[passkey.createdAt ? `Added ${day(passkey.createdAt)}` : '', passkey.backedUp ? 'Synced' : 'This device only'].filter(Boolean).join(' · ')}
			</span>
			<span className="account-item-actions">
				<Button variant="ghost" className="small" onClick={() => setEditing(true)} disabled={busy} aria-label={`Rename ${label}`}>Rename</Button>
				<Button variant="ghost" className="small" onClick={remove} disabled={busy} aria-label={`Remove ${label}`}>Remove</Button>
			</span>
		</li>
	);
}
