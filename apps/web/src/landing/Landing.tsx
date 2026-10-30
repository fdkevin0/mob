import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { authClient, keepOffer, loadSite, openApp, pendingOffer, returnAfterSignIn, type Site } from './auth';
import { Button } from '@mob/ui/button';
import { Dialog } from '@mob/ui/dialog';
import { Segmented } from '@mob/ui/segmented';
import { SignIn } from './SignIn';
import { SiteFooter, SiteHeader } from '../site/Site';
import { Story } from './Story';

const installs = {
	npm: { note: 'Linux, macOS and Windows.', lines: ['npm install -g usemob', 'mob start'], href: '/docs/install/', action: 'Install guide' },
	Bun: { note: 'The same package; --trust lets it install the native binary.', lines: ['bun add -g --trust usemob', 'mob start'], href: '/docs/install/', action: 'Install guide' },
	Download: { note: 'Archives for Linux, macOS and Windows. Every change to main is published as a nightly build.', lines: ['mob start', 'mob open --web'], href: 'https://github.com/fdkevin0/mob/releases', action: 'Download' },
	Source: { note: 'Needs Bun and just.', lines: ['git clone https://github.com/fdkevin0/mob && cd mob', 'just install && just build', './build/mob start'], href: '/docs/contributing/', action: 'Contributing guide' },
};
type Install = keyof typeof installs;

export function Landing() {
	const session = authClient.useSession();
	const [site, setSite] = useState<Site>();
	const [siteError, setSiteError] = useState('');
	const [dialog, setDialog] = useState<{ reason?: string }>();
	const [signedIn, setSignedIn] = useState(false);
	const [install, setInstall] = useState<Install>('npm');
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
		// Cloudflare with the email of an account GitHub made is connected from that account instead.
		else if (signin === 'failed') setDialog({ reason: params.get('error') === 'account_not_linked'
			? 'This email already has a Mob account. Sign in with GitHub, then connect Cloudflare on your account page.'
			: `Sign-in did not finish${params.get('error') ? ` (${params.get('error')})` : ''}. Try again.` });
		loadSite().then(setSite).catch(e => setSiteError(`Sign-in is unavailable right now. ${e instanceof Error ? e.message : ''}`.trim()));
	}, []);

	// Back from GitHub, or already signed in with a link waiting: on to the app.
	useEffect(() => { if (user && (signedIn || pendingOffer())) openApp(); }, [user, signedIn]);

	return (
		<Dialog open={!!dialog} onOpenChange={open => { if (!open) setDialog(undefined); }}>
		<div className="landing">
			<SiteHeader floating current="/" onSignIn={showSignIn} />

			<main>
				<Story hero={(
					<>
						<h1>Agents <em>for you</em>.</h1>
						<p className="hero-sub">A local-first assistant that runs your coding agents for you. Ask from any channel. Open source.</p>
						<div className="cta">
							{user
								? <Button onClick={openApp}>Open Mob</Button>
								: <Button aria-haspopup="dialog" aria-expanded={!!dialog} onClick={showSignIn}>Get started</Button>}
							<Button variant="outline" asChild><a href="https://github.com/fdkevin0/mob" rel="noreferrer">View source</a></Button>
						</div>
						<nav className="landing-sections" aria-label="On this page">
							<a href="#how">How it works</a><a href="#features">Features</a><a href="#start">Install</a>
						</nav>
						<a className="scroll-hint" href="#how">Scroll to watch them work <span aria-hidden="true">↓</span></a>
					</>
				)} />

				<section className="start" id="start">
					<h2>Start in a minute</h2>
					<div className="install">
						<Segmented tabs className="install-tabs" label="Ways to install" value={install} onChange={setInstall}
							options={(Object.keys(installs) as Install[]).map(name => ({ value: name, label: name }))} />
						<pre className="terminal" role="tabpanel" aria-label={`Install from ${install}`}><code>
							{installs[install].lines.map(line => <span key={line}><span className="prompt">$</span>{line}{'\n'}</span>)}
							<span className="ok">✓</span>Mob is running<span className="cursor" />
						</code></pre>
						<p className="install-note">{installs[install].note}</p>
					</div>
					<Button asChild><a href={installs[install].href} rel="noreferrer">{installs[install].action}</a></Button>
				</section>
			</main>

			<SiteFooter links={[
				{ href: '/demo', label: 'Demo' },
				{ href: '/docs/', label: 'Docs' },
				{ href: 'https://github.com/fdkevin0/mob/blob/main/CHANGELOG.md', label: 'Changelog' },
			]} />

			{dialog ? <SignIn site={site} siteError={siteError} reason={dialog.reason} returnFocus={signInTrigger} /> : null}
		</div>
		</Dialog>
	);
}
