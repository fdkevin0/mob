import { useEffect, useState } from 'react';
import { Logo } from '../../components/brand/Logo';
import { PixelIcon } from '../../components/brand/PixelIcon';
import type { IconName } from '../../components/brand/pixels';
import { Button } from '../../components/ui/button';
import { Agents } from './Agents';
import { Demo } from './Demo';

// /demo: Mob at work, replayed in the browser. One tab for agents working as
// a team, one for a conversation on the web or in a chat app.

type Tab = 'agents' | 'chat';
const tabs: Record<Tab, { label: string; title: string; text: string; points: { icon: IconName; title: string; text: string }[] }> = {
	agents: {
		label: 'Agent orchestration',
		title: 'Mob runs the team. You steer.',
		text: 'Mob splits a goal into tasks and hands each one to a coding agent on its own branch. Watch the tree grow, approve what needs you, stop or redirect any agent, and open a card to see what it did.',
		points: [
			{ icon: 'code', title: 'Hands out the work', text: 'Codex, Claude Agent, DeepSeek and more, each in its own worktree and branch.' },
			{ icon: 'shield', title: 'Asks in one place', text: 'Every approval waits on its card and in your chat app. Approve, stop or tell an agent what to do next.' },
			{ icon: 'search', title: 'Checks before it reports', text: 'Failed work goes to another agent. task_diff and task_check run on every branch, with the cost of each task.' },
		],
	},
	chat: {
		label: 'Conversation',
		title: 'Ask anywhere. It asks first.',
		text: 'Pick a task, open a tool call to see what it did, and decide the approval yourself. Switch to a chat app to get the same work back as just the conclusion.',
		points: [
			{ icon: 'channels', title: 'Every channel', text: 'The web, the desktop app, the terminal, email or a chat app all reach the same assistant.' },
			{ icon: 'shield', title: 'Nothing risky unasked', text: 'Writing files, running commands and sending things wait for your nod, and you can remember a grant.' },
			{ icon: 'memory', title: 'One history', text: 'Every conversation stays on your computer, whichever app you asked from.' },
		],
	},
};

const fromHash = (): Tab => typeof window !== 'undefined' && window.location.hash === '#chat' ? 'chat' : 'agents';

export function DemoPage() {
	const [tab, setTab] = useState<Tab>(fromHash);
	useEffect(() => {
		const follow = () => setTab(fromHash());
		window.addEventListener('hashchange', follow);
		return () => window.removeEventListener('hashchange', follow);
	}, []);
	const pick = (t: Tab) => {
		setTab(t);
		window.history.replaceState(null, '', t === 'agents' ? window.location.pathname : '#chat');
	};
	const current = tabs[tab];
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
				<div className="demo-intro">
					<p className="demo-kicker">Demo · replayed in your browser, nothing here calls a model</p>
					<div className="demo-tabs" role="tablist" aria-label="Demos">
						{(Object.keys(tabs) as Tab[]).map(t => (
							<button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls="demo-panel" onClick={() => pick(t)}>{tabs[t].label}</button>
						))}
					</div>
				</div>
				<div id="demo-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
					<div className="demo-copy">
						<h1>{current.title}</h1>
						<p>{current.text}</p>
					</div>
					{tab === 'agents' ? <Agents key="agents" /> : <Demo key="chat" />}
					<ul className="demo-points">
						{current.points.map(p => (
							<li key={p.title}><PixelIcon name={p.icon} size={18} /><div><h2>{p.title}</h2><p>{p.text}</p></div></li>
						))}
					</ul>
					<div className="demo-next">
						<Button asChild><a href="/#start">Install Mob</a></Button>
						<Button variant="outline" asChild><a href="/docs/">Read the docs</a></Button>
					</div>
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
