import type { FormEvent } from 'react';
import { ConversationEmptyState } from '../components/ai-elements/conversation';
import { Logo } from '../components/brand/Logo';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';

/**
 * Lobby is the public web workspace before a runner is connected. Signed-in visitors can look around and type;
 * anything that needs Mob, such as sending or opening plugins, calls connect to ask for a runner instead.
 */
export function Lobby({ draft, setDraft, connect }: { draft: string; setDraft: (draft: string) => void; connect: () => void }) {
	function send(event: FormEvent) {
		event.preventDefault();
		connect();
	}
	return (
		<div className="workspace">
			<aside className="sidebar">
				<div className="sidebar-brand">
					<Logo />
					<span>Not connected</span>
				</div>
				<Button variant="outline" className="new-chat" onClick={connect}>
					＋ New conversation
				</Button>
				<nav aria-label="Conversations">
					<p className="muted lobby-note">Your conversations appear here once a runner is connected.</p>
				</nav>
				<Button variant="ghost" className="sidebar-plugins" onClick={connect}>
					Plugins & cloud services
				</Button>
				<div className="sidebar-footer">
					<p>
						<span className="status-dot offline" /> No runner connected
					</p>
					<Button variant="ghost" asChild>
						<a href="/">Mob home</a>
					</Button>
					<Button variant="ghost" onClick={connect}>
						Connect a runner
					</Button>
				</div>
			</aside>
			<main className="chat-main">
				<div className="mobile-toolbar">
					<Logo size={24} />
					<Button variant="outline" className="small" onClick={connect}>
						Connect a runner
					</Button>
				</div>
				<header className="thread-header">
					<div>
						<p className="workspace-label">Your workspace</p>
						<Button variant="ghost" className="model-button" onClick={connect}>
							No runner connected
						</Button>
					</div>
					<span className="badge">Not connected</span>
				</header>
				<div className="conversation lobby-conversation">
					<ConversationEmptyState
						title="What’s on your mind?"
						description="Mob runs on your own computer. Connect a runner when you are ready to send."
					/>
				</div>
				<div className="composer-area">
					<form className="composer" onSubmit={send}>
						<Label className="sr-only" htmlFor="message">
							Message
						</Label>
						<Textarea
							id="message"
							placeholder="Message Mob…"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							rows={2}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault();
									e.currentTarget.form?.requestSubmit();
								}
							}}
						/>
						<Button disabled={!draft.trim()}>Send ↑</Button>
					</form>
					<p className="composer-hint">Your message stays here while you connect a runner.</p>
				</div>
			</main>
		</div>
	);
}
