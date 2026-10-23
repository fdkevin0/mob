import { Logo } from '../../components/brand/Logo';
import { PixelIcon } from '../../components/brand/PixelIcon';
import type { IconName } from '../../components/brand/pixels';
import { Button } from '../../components/ui/button';
import { Studio } from './Studio';

// /demo: one task, replayed in the browser from the message to the report,
// with the agents doing the work beside the conversation.

const points: { icon: IconName; title: string; text: string }[] = [
	{ icon: 'channels', title: 'Ask from anywhere', text: 'The web app, the terminal, email or a chat app. The same conversation, wherever you asked.' },
	{ icon: 'code', title: 'A team on it', text: 'Mob hands the work to Codex, Claude Agent, DeepSeek and more, each on its own branch.' },
	{ icon: 'shield', title: 'Asks you first', text: 'An approval waits in the conversation and on the agent. Answer either; stop or redirect any agent.' },
	{ icon: 'search', title: 'Checks, then reports', text: 'Failed work goes to another agent, every branch is checked, and you get the result with its cost.' },
];

export function DemoPage() {
	return (
		<div className="landing demo-page">
			<header className="nav"><div className="nav-inner">
				<a href="/" className="brand" aria-label="Mob home"><Logo /></a>
				<nav className="nav-links" aria-label="Sections">
					<a href="/">Home</a>
					<a href="/demo" aria-current="page">Demo</a>
					<a href="/docs/">Docs</a>
					<a href="https://github.com/fdkevin0/mob" rel="noreferrer">GitHub</a>
				</nav>
				<div className="nav-account"><Button variant="outline" className="small" asChild><a href="/app">Open Mob</a></Button></div>
			</div></header>

			<main className="demo-main">
				<div className="demo-copy">
					<p className="demo-kicker">Demo · replayed in your browser, nothing here calls a model</p>
					<h1>One message. A team of agents.</h1>
					<p>Ask in the conversation and watch Mob hand the work out beside it. Approve from either side, open an agent to see what it did, or switch to a chat app.</p>
				</div>
				<Studio />
				<ul className="demo-points">
					{points.map(p => (
						<li key={p.title}><PixelIcon name={p.icon} size={18} /><div><h2>{p.title}</h2><p>{p.text}</p></div></li>
					))}
				</ul>
				<div className="demo-next">
					<Button asChild><a href="/#start">Install Mob</a></Button>
					<Button variant="outline" asChild><a href="/docs/">Read the docs</a></Button>
				</div>
			</main>

			<footer className="footer">
				<div className="footer-brand"><Logo size={20} /><span>MIT licensed</span></div>
				<nav aria-label="Project links">
					<a href="/">Home</a>
					<a href="/docs/">Docs</a>
					<a href="https://github.com/fdkevin0/mob/releases" rel="noreferrer">Releases</a>
					<a href="https://github.com/fdkevin0/mob" rel="noreferrer">GitHub</a>
				</nav>
			</footer>
		</div>
	);
}
