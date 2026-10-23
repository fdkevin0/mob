import { useEffect, useState, type FormEvent } from 'react';
import { authClient, errorCode } from '../landing/auth';
import { Logo } from '../components/brand/Logo';
import { Icon } from '../components/brand/Icon';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

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
	const [login, setLogin] = useState<string>();
	const [error, setError] = useState('');
	useEffect(() => {
		authClient.listAccounts().then(result => {
			if (result.error) { setError(result.error.message || 'Could not load sign-in methods.'); return; }
			const linked = result.data as Linked[];
			setAccounts(linked);
			const github = linked.find(account => account.providerId === 'github');
			if (github) void githubLogin(github.id).then(setLogin);
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
					{login ? <a className="account-link" href={`https://github.com/${login}`} rel="noreferrer">@{login}</a> : null}
					<span className="account-muted">{accounts === undefined && !error ? 'Loading…' : github ? `Connected ${day(github.createdAt)}` : 'Not connected'}</span>
				</li>
			</ul>
			<p className="account-muted">GitHub created this account and stays connected. Passkeys below sign in to the same account.</p>
		</section>
	);
}

// githubLogin asks GitHub, with the stored token, for the current username, so a
// renamed account shows its new name. Without an answer the row only says Connected.
async function githubLogin(accountId: string) {
	try {
		const result = await authClient.accountInfo({ query: { accountId } });
		const login = (result.data?.data as { login?: unknown } | undefined)?.login;
		return typeof login === 'string' && /^[A-Za-z0-9-]+$/.test(login) ? login : undefined;
	} catch {
		return undefined;
	}
}

function Passkeys() {
	const list = authClient.useListPasskeys();
	const passkeys = (list.data ?? []) as Passkey[];
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [stale, setStale] = useState(false);
	const [notice, setNotice] = useState('');

	// The server names the passkey after its provider when the AAGUID is known;
	// it can be renamed afterwards.
	async function add() {
		setBusy(true); setError(''); setNotice(''); setStale(false);
		try {
			const result = await authClient.passkey.addPasskey();
			if (!result.error) { setNotice('Passkey added. Use it from Sign in on the Mob home page.'); return; }
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
				<div className="account-add">
					<Button type="button" onClick={() => void add()} disabled={busy}><Icon name="key" size={14} />{busy ? 'Waiting for your device…' : 'Add a passkey'}</Button>
				</div>
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
