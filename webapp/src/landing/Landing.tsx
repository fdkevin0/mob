import { useCallback, useEffect, useState } from 'react';
import { AgentFlow, steps } from './AgentFlow';
import { authClient, keepOffer, loadSite, openApp, pendingOffer, type Site } from './auth';
import { PixelIcon } from './PixelIcon';
import { SignIn } from './SignIn';
import { wordmark } from './pixels';
import type { IconName } from './pixels';

const features: { icon: IconName; title: string; text: string }[] = [
	{ icon: 'lock', title: 'Yours, on your machine', text: 'One small service keeps every conversation in SQLite on your computer, with your own model keys.' },
	{ icon: 'channels', title: 'On every channel', text: 'Talk to it from the web, the desktop app, the terminal, Telegram, WeChat or email. It answers where you asked.' },
	{ icon: 'shield', title: 'Asks before it acts', text: 'Reading is free. Anything with an effect waits for your approval, which you can give from any device.' },
	{ icon: 'box', title: 'Tools in a sandbox', text: 'Commands run in a container with limits on network, CPU and memory, isolated with gVisor on Linux.' },
	{ icon: 'spark', title: 'Skills and MCP', text: 'Load Agent Skills by name, connect MCP servers, and let the agent find the tool it needs.' },
	{ icon: 'terminal', title: 'Open source', text: 'MIT licensed and written in Go. Read it, run it, change it.' },
];

function Wordmark() {
	return (
		<svg className="wordmark" viewBox={`0 0 ${wordmark[0].length} ${wordmark.length}`} shapeRendering="crispEdges" aria-label="Mob" role="img">
			{wordmark.flatMap((row, y) => [...row].map((c, x) => c === '#' ? <rect key={`${x}.${y}`} x={x + 0.08} y={y + 0.08} width={0.84} height={0.84} fill="currentColor" /> : null))}
		</svg>
	);
}

export function Landing() {
	const session = authClient.useSession();
	const [site, setSite] = useState<Site>();
	const [siteError, setSiteError] = useState('');
	const [dialog, setDialog] = useState<{ reason?: string }>();
	const [phase, setPhase] = useState(0);
	const [menu, setMenu] = useState(false);
	const user = session.data?.user;

	useEffect(() => {
		const linked = keepOffer();
		const params = new URLSearchParams(window.location.search);
		const signin = params.get('signin');
		if (signin) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
		if (linked) setDialog({ reason: 'Sign in with GitHub to connect this browser to Mob on your computer.' });
		else if (signin === 'app') setDialog({});
		else if (signin === 'failed') setDialog({ reason: 'GitHub sign-in did not finish. Try again.' });
		loadSite().then(setSite).catch(e => setSiteError(`Sign-in is unavailable right now. ${e instanceof Error ? e.message : ''}`.trim()));
	}, []);

	// Someone already signed in goes straight on to a waiting link.
	useEffect(() => { if (user && pendingOffer()) openApp(); }, [user]);
	const onPhase = useCallback((next: number) => setPhase(next), []);
	const close = useCallback(() => setDialog(undefined), []);

	return (
		<div className="landing">
			<header className="nav">
				<a href="/" className="brand" aria-label="Mob home"><Wordmark /></a>
				<nav className="nav-links" aria-label="Sections">
					<a href="#loop">Loop</a>
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
					<p className="eyebrow"><span className="blink" />PERSONAL AGENT · LOCAL FIRST</p>
					<h1>An agent that works<br /><em>for you</em>, not for a platform.</h1>
					<p className="lede">Mob plans, uses tools, asks before anything risky, remembers what matters and reports back wherever you are. It runs on your computer, with your keys.</p>
					<div className="cta">
						{user
							? <button className="btn primary" onClick={openApp}>Open Mob</button>
							: <button className="btn primary" onClick={() => setDialog({})}>Get started</button>}
						<a className="btn ghost" href="https://github.com/fdkevin0/mob" rel="noreferrer">View source</a>
					</div>
				</section>

				<section className="stage" id="loop" aria-label="How the agent works">
					<div className="monitor">
						<span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
						<div className="monitor-bar">
							<span>mob://agent</span>
							<span className="live"><span className="dot" />running</span>
							<span>step {String(phase + 1).padStart(2, '0')}/{String(steps.length).padStart(2, '0')}</span>
						</div>
						<AgentFlow onPhase={onPhase} />
						<ol className="rail">
							{steps.map((step, i) => (
								<li key={step.title} aria-current={i === phase ? 'step' : undefined} className={i < phase ? 'past' : undefined}>
									<span className="rail-index">{String(i + 1).padStart(2, '0')}</span>
									<strong>{step.title}</strong>
									<span className="rail-text">{step.text}</span>
								</li>
							))}
						</ol>
					</div>
				</section>

				<section className="features" id="features">
					<h2><span className="section-mark">//</span> Built like a colleague, not a chatbot</h2>
					<div className="feature-grid">
						{features.map(feature => (
							<article key={feature.title} className="feature">
								<PixelIcon name={feature.icon} size={28} className="feature-icon" />
								<h3>{feature.title}</h3>
								<p>{feature.text}</p>
							</article>
						))}
					</div>
				</section>

				<section className="start" id="start">
					<div>
						<h2><span className="section-mark">//</span> Start in a minute</h2>
						<p>Download Mob for Linux, macOS or Windows, start it, then sign this page in to it. Your conversations never leave your computer: this site only holds your account.</p>
						<div className="cta">
							<a className="btn primary" href="https://github.com/fdkevin0/mob/releases" rel="noreferrer">Download</a>
							{user ? null : <button className="btn ghost" onClick={() => setDialog({})}>Sign in with GitHub</button>}
						</div>
					</div>
					<pre className="terminal" aria-label="Commands to start Mob"><code>
						<span className="muted"># run the service, with a free model to start</span>{'\n'}
						<span className="prompt">$</span> mob start{'\n'}
						<span className="muted"># open it here, signed in to your computer</span>{'\n'}
						<span className="prompt">$</span> mob open --web{'\n'}
						<span className="ok">✓</span> opened https://mob.fdkevin.cloud<span className="cursor" />
					</code></pre>
				</section>
			</main>

			<footer className="footer">
				<Wordmark />
				<span>Personal agent, made to run at home. MIT licensed.</span>
				<a href="https://github.com/fdkevin0/mob" rel="noreferrer">GitHub</a>
			</footer>

			{dialog ? <SignIn site={site} siteError={siteError} reason={dialog.reason} onClose={close} /> : null}
		</div>
	);
}
