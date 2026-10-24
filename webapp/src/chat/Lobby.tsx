import type { FormEvent } from 'react';
import { ConversationEmptyState } from '../components/ai-elements/conversation';
import { Logo } from '../components/brand/Logo';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { ThemePicker } from '../theme/ThemePicker';
import { ArrowUpIcon, ChevronDownIcon, PlusIcon } from './icons';

/**
 * Lobby is the public web workspace after leaving the browser runner, before another is connected. Signed-in visitors can look around and type;
 * anything that needs Mob, such as sending or opening plugins, calls connect to ask for a runner instead.
 */
export function Lobby({
	draft,
	setDraft,
	connect,
	connecting,
	notice,
}: {
	draft: string;
	setDraft: (draft: string) => void;
	connect: () => void;
	/** connecting is true while a saved connection is being restored; the lobby then shows that instead of "not connected". */
	connecting?: boolean;
	/** notice explains why restoring the saved connection failed. */
	notice?: string;
}) {
	function send(event: FormEvent) {
		event.preventDefault();
		if (draft.trim()) connect();
	}
	const status = connecting ? 'Connecting…' : 'No runner connected';
	return (
		<div className="workspace">
			<aside className="sidebar">
				<div className="sidebar-brand">
					<Logo size={26} />
					<span className="muted">{connecting ? 'Connecting…' : 'Not connected'}</span>
				</div>
				<Button variant="ghost" className="sidebar-link" disabled={connecting} onClick={connect}>
					<PlusIcon /> New conversation
				</Button>
				<nav aria-label="Conversations" className="conversation-list">
					<p className="muted lobby-note">Your conversations appear here once a runner is connected.</p>
				</nav>
				<Button variant="ghost" className="sidebar-link" disabled={connecting} onClick={connect}>
					Plugins & cloud services
				</Button>
				<div className="sidebar-pages">
					<p className="muted lobby-note">
						<span className="status-dot offline" /> {status}
					</p>
					{notice && !connecting && <p className="lobby-notice">{notice}</p>}
					<div className="menu-row">
						Theme <ThemePicker />
					</div>
					<Button variant="ghost" className="sidebar-link" asChild>
						<a href="/">Mob home</a>
					</Button>
					<Button variant="ghost" className="sidebar-link" asChild>
						<a href="/account">Account</a>
					</Button>
					<Button variant="ghost" className="sidebar-link" disabled={connecting} onClick={connect}>
						Connect a runner
					</Button>
				</div>
			</aside>
			<main className="chat-main">
				<div className="mobile-toolbar">
					<Logo size={24} />
					<Button variant="outline" className="small" disabled={connecting} onClick={connect}>
						Connect a runner
					</Button>
				</div>
				<header className="view-header">
					<div className="view-header-inner">
						<h1>New conversation</h1>
					</div>
				</header>
				<div className="conversation lobby-conversation">
					<ConversationEmptyState
						className="empty-state"
						title="What’s on your mind?"
						description="Choose where Mob runs: in this browser, or on a runner of your own."
					/>
				</div>
				<div className="composer-area">
					<form className="composer" onSubmit={send}>
						<Label className="sr-only" htmlFor="message">
							Message
						</Label>
						<Textarea
							id="message"
							placeholder="Message Mob, or type / for commands"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							rows={1}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault();
									e.currentTarget.form?.requestSubmit();
								}
							}}
						/>
						<div className="composer-bar">
							<Button type="button" variant="ghost" className="model-button" disabled={connecting} onClick={connect}>
								{status}
								<ChevronDownIcon />
							</Button>
							<Button className="send-button" aria-label="Send" title="Send (Enter)" disabled={connecting || !draft.trim()}>
								<ArrowUpIcon />
							</Button>
						</div>
					</form>
				</div>
			</main>
		</div>
	);
}
