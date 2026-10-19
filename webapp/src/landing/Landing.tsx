import { useCallback, useEffect, useState } from 'react';
import { authClient, keepOffer, loadSite, openApp, pendingOffer, type Site } from './auth';
import { Features } from './Features';
import { Logo } from './Logo';
import { PixelIcon } from './PixelIcon';
import { SignIn } from './SignIn';
import { VoxelCanvas } from './voxel/VoxelCanvas';
import { officeFrame, officeVoxels } from './voxel/office';

export function Landing() {
	const session = authClient.useSession();
	const [site, setSite] = useState<Site>();
	const [siteError, setSiteError] = useState('');
	const [dialog, setDialog] = useState<{ reason?: string }>();
	const [menu, setMenu] = useState(false);
	const [signedIn, setSignedIn] = useState(false);
	const user = session.data?.user;

	useEffect(() => {
		const linked = keepOffer();
		const params = new URLSearchParams(window.location.search);
		const signin = params.get('signin');
		if (signin) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
		if (linked) setDialog({ reason: 'Sign in with GitHub to connect this browser to Mob on your computer.' });
		else if (signin === 'app') setDialog({});
		else if (signin === 'done') setSignedIn(true);
		else if (signin === 'failed') setDialog({ reason: 'GitHub sign-in did not finish. Try again.' });
		loadSite().then(setSite).catch(e => setSiteError(`Sign-in is unavailable right now. ${e instanceof Error ? e.message : ''}`.trim()));
	}, []);

	// Back from GitHub, or already signed in with a link waiting: on to the app.
	useEffect(() => { if (user && (signedIn || pendingOffer())) openApp(); }, [user, signedIn]);
	const close = useCallback(() => setDialog(undefined), []);

	return (
		<div className="landing">
			<header className="nav">
				<a href="/" className="brand" aria-label="Mob home"><Logo /></a>
				<nav className="nav-links" aria-label="Sections">
					<a href="#features">Features</a>
					<a href="#start">Start</a>
					<a href="https://github.com/fdkevin0/mob" rel="noreferrer">GitHub</a>
				</nav>
				<div className="nav-account">
					{session.isPending ? <span className="nav-pending" aria-hidden="true" /> : user ? (
						<div className="account">
							<button className="btn primary small" onClick={openApp}>Open Mob</button>
							<button className="avatar" aria-label="Account" aria-expanded={menu} onClick={() => setMenu(open => !open)}>
								{user.image ? <img src={user.image} alt="" /> : (user.name || user.email).slice(0, 1).toUpperCase()}
							</button>
							{menu ? (
								<div className="account-menu" role="menu">
									<p><strong>{user.name}</strong>{user.email}</p>
									<button role="menuitem" onClick={async () => { await authClient.signOut(); setMenu(false); }}>Sign out</button>
								</div>
							) : null}
						</div>
					) : (
						<button className="btn ghost small" onClick={() => setDialog({})}><PixelIcon name="lock" size={12} /> Sign in</button>
					)}
				</div>
			</header>

			<main>
				<section className="hero">
					<VoxelCanvas className="hero-field" scene={officeVoxels} frame={officeFrame} gpu pixel={2} fps={20} still={24} label="An office of small voxel calves working at their desks, high-fiving, fetching milk tea and napping" />
					<div className="hero-copy">
						<h1>Agents <em>for you</em>.</h1>
						<p className="hero-sub">Local first · every channel · open source</p>
						<div className="cta">
							{user
								? <button className="btn primary" onClick={openApp}>Open Mob</button>
								: <button className="btn primary" onClick={() => setDialog({})}>Get started</button>}
							<a className="btn ghost" href="https://github.com/fdkevin0/mob" rel="noreferrer">View source</a>
						</div>
					</div>
				</section>

				<section className="features" id="features" aria-label="Features">
					<Features />
				</section>

				<section className="start" id="start">
					<h2>Start in a minute</h2>
					<pre className="terminal" aria-label="Commands to start Mob"><code>
						<span className="prompt">$</span> mob start{'\n'}
						<span className="prompt">$</span> mob open --web{'\n'}
						<span className="ok">✓</span> signed in<span className="cursor" />
					</code></pre>
					<div className="cta">
						<a className="btn primary" href="https://github.com/fdkevin0/mob/releases" rel="noreferrer">Download</a>
					</div>
				</section>
			</main>

			<footer className="footer">
				<Logo size={20} />
				<span>MIT licensed</span>
				<a href="https://github.com/fdkevin0/mob" rel="noreferrer">GitHub</a>
			</footer>

			{dialog ? <SignIn site={site} siteError={siteError} reason={dialog.reason} onClose={close} /> : null}
		</div>
	);
}
