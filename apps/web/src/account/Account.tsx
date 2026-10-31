import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authClient, errorCode, loadSite } from '../landing/auth';
import { Icon } from '@mob/ui/brand/Icon';
import { Button } from '@mob/ui/button';
import { Input } from '@mob/ui/input';
import { SiteHeader } from '../site/Site';
import { Notice } from '@mob/ui/notice';
import { GitHubApp } from './GitHubApp';

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

// The account page lists how the visitor signs in: GitHub or Cloudflare, and
// passkeys bound to the account, and where the Mob GitHub App is installed.
export function Account() {
	const session = authClient.useSession();
	const user = session.data?.user;
	useEffect(() => {
		if (!session.isPending && !user && !session.error) window.location.assign('/?signin=account');
	}, [session.isPending, user, session.error]);

	if (session.isPending || !user) return (
		<div className="account-page"><SiteHeader current="/account" /><main className="account-main">
			{session.error ? <Notice tone="error" title="Could not load your account.">Check your connection and reload the page.</Notice> : <p className="account-muted">Loading…</p>}
		</main></div>
	);
	return (
		<div className="account-page">
			<SiteHeader current="/account" />
			<main className="account-main">
				<div className="account-title">
					<h1>Account</h1>
					<Button variant="ghost" className="small" onClick={() => { void authClient.signOut().finally(() => window.location.assign('/')); }}>Sign out</Button>
				</div>
				<section className="account-card account-profile" aria-label="Profile">
					<span className="avatar large">{user.image ? <img src={user.image} alt="" /> : (user.name || user.email).slice(0, 1).toUpperCase()}</span>
					<div><strong>{user.name}</strong><span>{user.email}</span></div>
				</section>
				<SignInMethods />
				<Passkeys />
				<GitHubApp />
			</main>
		</div>
	);
}

type Provider = 'github' | 'cloudflare';
const providerNames: Record<Provider, string> = { github: 'GitHub', cloudflare: 'Cloudflare' };

function SignInMethods() {
	const [accounts, setAccounts] = useState<Linked[]>();
	const [login, setLogin] = useState<string>();
	const [cloudflare, setCloudflare] = useState(false);
	const [busy, setBusy] = useState<Provider>();
	const [error, setError] = useState('');
	function load() {
		authClient.listAccounts().then(result => {
			if (result.error) { setError(result.error.message || 'Could not load sign-in methods.'); return; }
			const linked = result.data as Linked[];
			setAccounts(linked);
			const github = linked.find(account => account.providerId === 'github');
			if (github) void githubLogin(github.id).then(setLogin);
		}).catch(e => setError(errorText(e)));
	}
	useEffect(() => {
		// A provider that refused to connect sends the visitor back with ?error=.
		const failed = new URLSearchParams(window.location.search).get('error');
		if (failed) {
			setError(failed === 'account_already_linked_to_different_user' ? 'That account already signs in to another Mob account.' : `Connecting did not finish (${failed}). Try again.`);
			window.history.replaceState(null, '', window.location.pathname);
		}
		load();
		loadSite().then(site => setCloudflare(!!site.cloudflare)).catch(() => setCloudflare(false));
	}, []);
	const find = (provider: Provider) => accounts?.find(account => account.providerId === provider);
	// Connecting goes through the provider and comes back here, linked to this account.
	async function connect(provider: Provider) {
		setBusy(provider); setError('');
		try {
			const result = await authClient.linkSocial({ provider, callbackURL: '/account', errorCallbackURL: '/account' });
			if (result.error) setError(result.error.message || `${providerNames[provider]} did not open. Try again.`);
			else return;
		} catch (e) { setError(errorText(e)); }
		setBusy(undefined);
	}
	// One request at a time: a second Disconnect sent before the list refreshes
	// would find only the last way to sign in left and be refused.
	const working = useRef(false);
	async function disconnect(provider: Provider, account: Linked) {
		if (working.current || !window.confirm(`Disconnect ${providerNames[provider]}? Mob in the browser stops using its models.`)) return;
		working.current = true;
		setBusy(provider); setError('');
		try {
			const result = await authClient.unlinkAccount({ accountId: account.id });
			if (result.error) setError(result.error.code === 'FAILED_TO_UNLINK_LAST_ACCOUNT' ? 'This is how you sign in, so it stays connected.' : result.error.message || 'Could not disconnect.');
		} catch (e) { setError(errorText(e)); }
		// The list is read again either way, so the page shows what the server keeps.
		load();
		working.current = false;
		setBusy(undefined);
	}
	const rows: Provider[] = cloudflare || find('cloudflare') ? ['github', 'cloudflare'] : ['github'];
	const connected = rows.filter(find).length;
	return (
		<section className="account-card" aria-labelledby="methods-title">
			<h2 id="methods-title">Sign-in methods</h2>
			{error ? <Notice tone="error">{error}</Notice> : null}
			<ul className="account-list">
				{rows.map(provider => {
					const account = find(provider);
					return (
						<li key={provider}>
							<span className="account-item-name">{providerNames[provider]}</span>
							{provider === 'github' && login ? <a className="account-link" href={`https://github.com/${login}`} rel="noreferrer">@{login}</a> : null}
							<span className="account-muted">{accounts === undefined && !error ? 'Loading…' : account ? `Connected ${day(account.createdAt)}` : 'Not connected'}</span>
							{accounts !== undefined ? (
								<span className="account-item-actions">
									{!account ? <Button type="button" variant="outline" className="small" onClick={() => void connect(provider)} disabled={!!busy}>{busy === provider ? 'Opening…' : 'Connect'}</Button>
										: connected > 1 ? <Button type="button" variant="ghost" className="small" onClick={() => void disconnect(provider, account)} disabled={!!busy}>Disconnect</Button>
										: null}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
			<p className="account-muted">{rows.length > 1 ? 'Either one signs in to this account. Cloudflare also lets Mob in the browser run Workers AI models on your Cloudflare account; Mob keeps its sign-in encrypted on the server. ' : ''}Passkeys below sign in to the same account.</p>
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
			if (!result.error) { setNotice('Passkey added. Use it from Get started on the Mob home page.'); return; }
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
			{list.error ? <Notice tone="error">{list.error.message || 'Could not load passkeys.'}</Notice> : null}
			{list.isPending ? <p className="account-muted">Loading…</p> : passkeys.length === 0 ? <p className="account-empty">No passkeys yet.</p> : (
				<ul className="account-list">
					{passkeys.map(passkey => <PasskeyRow key={passkey.id} passkey={passkey} onError={setError} />)}
				</ul>
			)}
			{supported() ? (
				<div className="account-add">
					<Button type="button" onClick={() => void add()} disabled={busy}><Icon name="key" size={14} />{busy ? 'Waiting for your device…' : 'Add a passkey'}</Button>
				</div>
			) : <Notice tone="warning" role="note">This browser does not support passkeys.</Notice>}
			{stale ? (
				<Notice tone="warning" actions={<Button variant="outline" onClick={signInAgain}>Sign in again</Button>}>
					For your safety, sign in with GitHub again before adding a passkey.
				</Notice>
			) : null}
			{error ? <Notice tone="error">{error}</Notice> : null}
			{notice ? <Notice tone="success">{notice}</Notice> : null}
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
