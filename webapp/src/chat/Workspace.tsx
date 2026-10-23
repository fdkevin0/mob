import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Changes } from '@mob/client';
import { api, isPublicWeb, webClient, type Connection, type Conversation, type Snapshot } from './api';
import type { Action } from './contracts';
import { Logo } from '../components/brand/Logo';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../components/ui/sheet';
import { Thread } from './Thread';
import { PlusIcon } from './icons';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Panels load on first use, so the chat opens without their code.
const AgentTree = lazy(() => import('./AgentTree').then((m) => ({ default: m.AgentTree })));
const Plugins = lazy(() => import('./Plugins').then((m) => ({ default: m.Plugins })));
const Usage = lazy(() => import('./Usage').then((m) => ({ default: m.Usage })));
const panel = <div className="loading" role="status">Loading…</div>;

// The address names the open conversation, as #/c/<id>, so reloading or going back returns to it.
const routePrefix = '#/c/';
function routedID() {
	return window.location.hash.startsWith(routePrefix) ? decodeURIComponent(window.location.hash.slice(routePrefix.length)) : undefined;
}
function route(id: string, replace: boolean) {
	const hash = routePrefix + encodeURIComponent(id);
	if (window.location.hash === hash) return;
	if (replace) window.history.replaceState(window.history.state, '', hash);
	else window.history.pushState(window.history.state, '', hash);
}
// Recently opened conversations are kept in memory, so switching back shows them at once while they refresh.
const cacheSize = 20;

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
	const [agents, setAgents] = useState(false);
	const [navigation, setNavigation] = useState(false);
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [selected, setSelected] = useState<{ id: string; snapshot: Snapshot }>();
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [background, setBackground] = useState(false);

	// The service says what changed, so the list and the open views reload only then.
	const changes = useMemo(() => new Changes(webClient(connection)), [connection]);
	useEffect(changes.start, [changes]);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = changes.subscribe((change) => {
			if (change !== 'reset' && !change.list) return;
			clearTimeout(timer);
			timer = setTimeout(() => void refreshList().catch(() => { /* the next change or action refreshes it */ }), 200);
		});
		return () => {
			unsubscribe();
			clearTimeout(timer);
		};
	}, [changes]);
	const cache = useRef(new Map<string, Snapshot>());
	const remember = (id: string, snapshot: Snapshot) => {
		cache.current.delete(id);
		cache.current.set(id, snapshot);
		if (cache.current.size > cacheSize) cache.current.delete(cache.current.keys().next().value!);
	};
	const fetching = useRef(new Map<string, Promise<Snapshot>>());
	function load(id: string) {
		let request = fetching.current.get(id);
		if (!request) {
			request = api<Snapshot>(connection, `/conversations/${id}`).finally(() => fetching.current.delete(id));
			fetching.current.set(id, request);
		}
		return request;
	}
	// prefetch loads a conversation the pointer or focus is on, so opening it does not wait.
	function prefetch(id: string) {
		if (cache.current.has(id) || id === selected?.id) return;
		load(id).then((snapshot) => remember(id, snapshot)).catch(() => { /* opening it reports the failure */ });
	}

	async function refreshList() {
		setConversations(await api(connection, '/conversations'));
	}
	function show(id: string, snapshot: Snapshot, replace = false) {
		setSelected({ id, snapshot });
		route(id, replace);
		setNavigation(false);
		setAgents(false);
	}
	// choice counts what was asked to show, so a slow response for an earlier choice is dropped.
	const choice = useRef(0);
	async function open(id: string, replace = false) {
		const ticket = ++choice.current;
		setError('');
		// A cached conversation shows at once; its thread reloads the latest messages as it opens.
		const cached = cache.current.get(id);
		if (cached) return show(id, cached, replace);
		setSwitching(true);
		try {
			const snapshot = await load(id);
			if (ticket === choice.current) show(id, snapshot, replace);
		} catch (e) {
			if (ticket === choice.current) setError(errorText(e));
		} finally {
			if (ticket === choice.current) setSwitching(false);
		}
	}
	function act(action: Action) {
		if (action.kind === 'open-conversation' && action.conversationId)
			void refreshList()
				.then(() => open(action.conversationId!))
				.catch((e) => setError(errorText(e)));
		else if (action.kind === 'open-plugins' || action.kind === 'compose-mail') setPlugins(true);
	}
	// A new conversation opens as soon as the service names it; the list refreshes behind it.
	async function create(replace = false) {
		const ticket = ++choice.current;
		setSwitching(true);
		try {
			const next = await api<Conversation>(connection, '/conversations', {});
			setConversations((list) => [next, ...list.filter((c) => c.id !== next.id)]);
			if (ticket === choice.current) show(next.id, { messages: [], active: false, model: '' }, replace);
			void refreshList().catch((e) => setError(errorText(e)));
		} catch (e) {
			if (ticket === choice.current) setError(errorText(e));
		} finally {
			if (ticket === choice.current) setSwitching(false);
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
				const routed = routedID();
				if (draft || !list.length) await create(true);
				else await open(routed && list.some((c) => c.id === routed) ? routed : list[0].id, true);
			} catch (e) {
				if (live) setError(errorText(e));
			}
		})();
		return () => {
			live = false;
		};
	}, [connection]);
	// Back and forward move between the conversations the address named.
	const opener = useRef(open);
	opener.current = open;
	const current = useRef(selected?.id);
	current.current = selected?.id;
	useEffect(() => {
		const follow = () => {
			const id = routedID();
			if (id && id !== current.current) void opener.current(id, true);
		};
		window.addEventListener('popstate', follow);
		return () => window.removeEventListener('popstate', follow);
	}, []);

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
						onPointerEnter={() => prefetch(c.id)}
						onFocus={() => prefetch(c.id)}
					>
						{c.title}
					</Button>
				))}
			</nav>
			<Button
				variant="ghost"
				className="sidebar-plugins"
				aria-current={agents ? 'page' : undefined}
				disabled={busy}
				onClick={() => {
					setNavigation(false);
					setAgents(true);
				}}
			>
				Agents
			</Button>
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

	if (plugins)
		return (
			<Suspense fallback={panel}>
				<Plugins connection={connection} close={() => setPlugins(false)} />
			</Suspense>
		);
	if (usage)
		return (
			<Suspense fallback={panel}>
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
			</Suspense>
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
				{agents ? (
					<Suspense fallback={panel}>
						<AgentTree
							connection={connection}
							changes={changes}
							open={(id) => void refreshList().then(() => open(id)).catch((e) => setError(errorText(e)))}
							close={() => setAgents(false)}
						/>
					</Suspense>
				) : selected ? (
					<Thread
						key={selected.id}
						connection={connection}
						id={selected.id}
						initial={selected.snapshot}
						title={conversations.find((c) => c.id === selected.id)?.title}
						onBusy={setBusy}
						onLeave={(snapshot) => remember(selected.id, snapshot)}
						changes={changes}
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
