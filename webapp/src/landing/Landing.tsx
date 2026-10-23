import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { authClient, keepOffer, loadSite, openApp, pendingOffer, returnAfterSignIn, type Site } from './auth';
import { Logo } from '../components/brand/Logo';
import { Icon } from '../components/brand/Icon';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { SignIn } from './SignIn';
import { Story } from './Story';

const installs = {
	Download: { note: 'Archives for Linux, macOS and Windows. Every change to main is published as a nightly build.', lines: ['mob start', 'mob open --web'], href: 'https://github.com/fdkevin0/mob/releases', action: 'Download' },
	Homebrew: { note: 'The tap is published with the first stable release.', lines: ['brew install fdkevin0/tap/mob', 'mob start'], href: 'https://github.com/fdkevin0/homebrew-tap', action: 'View the tap' },
	Source: { note: 'Needs Go, Bun and just.', lines: ['git clone https://github.com/fdkevin0/mob && cd mob', 'just install && just build', './build/mob start'], href: '/docs/contributing/', action: 'Contributing guide' },
};
type Install = keyof typeof installs;

export function Landing() {
	const session = authClient.useSession();
	const [site, setSite] = useState<Site>();
	const [siteError, setSiteError] = useState('');
	const [dialog, setDialog] = useState<{ reason?: string }>();
	const [signedIn, setSignedIn] = useState(false);
	const [install, setInstall] = useState<Install>('Download');
	const signInTrigger = useRef<HTMLButtonElement>(null);
	const user = session.data?.user;
	function showSignIn(event: MouseEvent<HTMLButtonElement>) {
		signInTrigger.current = event.currentTarget;
		setDialog({});
	}

	useEffect(() => {
		const linked = keepOffer();
		const params = new URLSearchParams(window.location.search);
		const signin = params.get('signin');
		if (signin) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
		if (linked) setDialog({ reason: 'Sign in with GitHub to connect this browser to Mob on your computer.' });
		else if (signin === 'app') setDialog({});
		else if (signin === 'account') { returnAfterSignIn('/account'); setDialog({ reason: 'Sign in to manage your account and passkeys.' }); }
		else if (signin === 'done') setSignedIn(true);
		else if (signin === 'failed') setDialog({ reason: 'GitHub sign-in did not finish. Try again.' });
		loadSite().then(setSite).catch(e => setSiteError(`Sign-in is unavailable right now. ${e instanceof Error ? e.message : ''}`.trim()));
	}, []);

	// Back from GitHub, or already signed in with a link waiting: on to the app.
	useEffect(() => { if (user && (signedIn || pendingOffer())) openApp(); }, [user, signedIn]);

	return (
		<Dialog open={!!dialog} onOpenChange={open => { if (!open) setDialog(undefined); }}>
		<div className="landing">
			<header className="nav"><div className="nav-inner">
				<a href="/" className="brand" aria-label="Mob home"><Logo /></a>
				<nav className="nav-links" aria-label="Sections">
					<a href="#how">How it works</a>
					<a href="#features">Features</a>
					<a href="#start">Start</a>
					<a href="/docs/">Docs</a>
					<a href="https://github.com/fdkevin0/mob" rel="noreferrer">GitHub</a>
				</nav>
				<div className="nav-account">
					{session.isPending ? <span className="nav-pending" aria-hidden="true" /> : user ? (
						<div className="account">
							<Button className="small" onClick={openApp}>Open Mob</Button>
							<DropdownMenu>
							<DropdownMenuTrigger asChild><button className="avatar" aria-label="Account">
								{user.image ? <img src={user.image} alt="" /> : (user.name || user.email).slice(0, 1).toUpperCase()}
							</button></DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuLabel className="ui-menu-label"><strong>{user.name}</strong>{user.email}</DropdownMenuLabel>
								<DropdownMenuItem className="ui-menu-item" asChild><a href="/account">Account</a></DropdownMenuItem>
								<DropdownMenuItem className="ui-menu-item" onSelect={() => { void authClient.signOut(); }}>Sign out</DropdownMenuItem>
							</DropdownMenuContent>
							</DropdownMenu>
						</div>
					) : (
						<Button variant="outline" className="small" aria-haspopup="dialog" aria-expanded={!!dialog} onClick={showSignIn}><Icon name="lock" size={14} /> Sign in</Button>
					)}
				</div>
			</div></header>

			<main>
				<Story hero={(
					<>
						<h1>Agents <em>for you</em>.</h1>
						<p className="hero-sub">A local-first assistant you can reach from every channel. Open source.</p>
						<div className="cta">
							{user
								? <Button onClick={openApp}>Open Mob</Button>
								: <Button aria-haspopup="dialog" aria-expanded={!!dialog} onClick={showSignIn}>Get started</Button>}
							<Button variant="outline" asChild><a href="https://github.com/fdkevin0/mob" rel="noreferrer">View source</a></Button>
						</div>
						<a className="scroll-hint" href="#how">Scroll to watch them work <span aria-hidden="true">↓</span></a>
					</>
				)} />

				<section className="start" id="start">
					<h2>Start in a minute</h2>
					<div className="install">
						<div className="install-tabs" role="tablist" aria-label="Ways to install">
							{(Object.keys(installs) as Install[]).map(name => (
								<button key={name} type="button" role="tab" aria-selected={install === name} onClick={() => setInstall(name)}>{name}</button>
							))}
						</div>
						<pre className="terminal" role="tabpanel" aria-label={`Install from ${install}`}><code>
							{installs[install].lines.map(line => <span key={line}><span className="prompt">$</span>{line}{'\n'}</span>)}
							<span className="ok">✓</span>Mob is running<span className="cursor" />
						</code></pre>
						<p className="install-note">{installs[install].note}</p>
					</div>
					<Button asChild><a href={installs[install].href} rel="noreferrer">{installs[install].action}</a></Button>
				</section>
			</main>

			<footer className="footer">
				<div className="footer-brand"><Logo size={20} /><span>MIT licensed</span></div>
				<nav aria-label="Project links">
					<a href="/docs/">Docs</a>
					<a href="https://github.com/fdkevin0/mob/blob/main/CHANGELOG.md" rel="noreferrer">Changelog</a>
					<a href="https://github.com/fdkevin0/mob/releases" rel="noreferrer">Releases</a>
					<a href="https://github.com/fdkevin0/mob" rel="noreferrer">GitHub</a>
				</nav>
			</footer>

			{dialog ? <SignIn site={site} siteError={siteError} reason={dialog.reason} returnFocus={signInTrigger} /> : null}
		</div>
		</Dialog>
	);
}
