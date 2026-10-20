import { useEffect, useState } from 'react';
import { api, isPublicWeb, type Connection, type Conversation, type Snapshot } from './api';
import type { Action } from './contracts';
import { Logo } from '../components/brand/Logo';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../components/ui/sheet';
import { Plugins } from './Plugins';
import { Usage } from './Usage';
import { Thread } from './Thread';
import { PlusIcon } from './icons';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function Workspace({
	connection,
	disconnect,
	draft,
	clearDraft,
}: {
	connection: Connection;
	disconnect: () => void;
	draft?: string;
	clearDraft?: () => void;
}) {
	const [plugins, setPlugins] = useState(false);
	const [usage, setUsage] = useState(false);
	const [navigation, setNavigation] = useState(false);
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [selected, setSelected] = useState<{ id: string; snapshot: Snapshot }>();
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [background, setBackground] = useState(false);

	async function refreshList() {
		setConversations(await api(connection, '/conversations'));
	}
	async function open(id: string) {
		setSwitching(true);
		setError('');
		try {
			const snapshot = await api<Snapshot>(connection, `/conversations/${id}`);
			setSelected({ id, snapshot });
			setNavigation(false);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setSwitching(false);
		}
	}
	function act(action: Action) {
		if (action.kind === 'open-conversation' && action.conversationId)
			void refreshList()
				.then(() => open(action.conversationId!))
				.catch((e) => setError(errorText(e)));
		else if (action.kind === 'open-plugins' || action.kind === 'compose-mail') setPlugins(true);
	}
	async function create() {
		setSwitching(true);
		try {
			const next = await api<Conversation>(connection, '/conversations', {});
			await refreshList();
			await open(next.id);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setSwitching(false);
		}
	}
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const [list, runtime] = await Promise.all([
					api<Conversation[]>(connection, '/conversations'),
					api<{ background: boolean }>(connection, '/runtime'),
				]);
				if (!live) return;
				setConversations(list);
				setBackground(runtime.background);
				// A draft typed before connecting starts a new conversation, as the lobby showed.
				if (list.length && !draft) await open(list[0].id);
				else await create();
			} catch (e) {
				if (live) setError(errorText(e));
			}
		})();
		return () => {
			live = false;
		};
	}, [connection]);

	const links = (
		<>
			<Button variant="outline" className="new-chat" disabled={busy || switching} onClick={() => void create()}>
				<PlusIcon /> New conversation
			</Button>
			<nav aria-label="Conversations">
				{conversations.map((c) => (
					<Button
						variant="ghost"
						className="conversation-link"
						key={c.id}
						aria-current={selected?.id === c.id ? 'page' : undefined}
						disabled={busy || switching}
						onClick={() => void open(c.id)}
					>
						{c.title}
					</Button>
				))}
			</nav>
			<Button
				variant="ghost"
				className="sidebar-plugins"
				disabled={busy}
				onClick={() => {
					setNavigation(false);
					setPlugins(true);
				}}
			>
				Plugins & cloud services
			</Button>
			<Button
				variant="ghost"
				className="sidebar-plugins"
				disabled={busy}
				onClick={() => {
					setNavigation(false);
					setUsage(true);
				}}
			>
				Token usage
			</Button>
			<div className="sidebar-footer">
				<p title={background ? 'Mob keeps running after this window closes' : 'Mob stops with the process that started it'}>
					<span className="status-dot" /> History {connection.runner ? 'on your runner' : 'on this computer'} ·{' '}
					{background ? 'keeps running' : 'stops with its process'}
				</p>
				{isPublicWeb() && (
					<>
						<Button variant="ghost" asChild>
							<a href="/">Mob home</a>
						</Button>
						<Button variant="ghost" asChild>
							<a href="/account">Account</a>
						</Button>
					</>
				)}
				<Button variant="ghost" onClick={disconnect} disabled={busy}>
					Disconnect
				</Button>
			</div>
		</>
	);

	if (plugins) return <Plugins connection={connection} close={() => setPlugins(false)} />;
	if (usage)
		return (
			<Usage
				connection={connection}
				close={() => setUsage(false)}
				open={(id) => {
					setUsage(false);
					void refreshList()
						.then(() => open(id))
						.catch((e) => setError(errorText(e)));
				}}
			/>
		);
	return (
		<div className="workspace">
			<aside className="sidebar">
				<div className="sidebar-brand">
					<Logo />
					<span>{connection.runner ? 'Remote runner' : 'On this computer'}</span>
				</div>
				{links}
			</aside>
			<main className="chat-main">
				<div className="mobile-toolbar">
					<Logo size={24} />
					<Sheet open={navigation} onOpenChange={setNavigation}>
						<SheetTrigger asChild>
							<Button variant="outline" className="small">
								Conversations
							</Button>
						</SheetTrigger>
						<SheetContent>
							<SheetTitle className="dialog-title">Conversations</SheetTitle>
							<SheetDescription className="dialog-description">
								Your history stays {connection.runner ? 'on your runner' : 'on this computer'}.
							</SheetDescription>
							{links}
						</SheetContent>
					</Sheet>
				</div>
				{error && (
					<div className="error" role="alert">
						{error}
						<Button variant="ghost" onClick={() => void refreshList().catch((e) => setError(errorText(e)))}>
							Refresh
						</Button>
					</div>
				)}
				{selected ? (
					<Thread
						key={selected.id}
						connection={connection}
						id={selected.id}
						initial={selected.snapshot}
						title={conversations.find((c) => c.id === selected.id)?.title}
						onBusy={setBusy}
						onChanged={() => {
							void refreshList().catch((e) => setError(errorText(e)));
						}}
						onAction={act}
						draft={draft}
						clearDraft={clearDraft}
					/>
				) : (
					<div className="loading" role="status">
						Opening workspace…
					</div>
				)}
			</main>
		</div>
	);
}
