import { lazy, Suspense, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Changes } from '@mob/client';
import { api, isPublicWeb, webClient, type Connection, type Conversation, type Snapshot } from './api';
import type { ManagementTab } from './Management';
import type { Action } from './contracts';
import { Button } from '@mob/ui/button';
import { Dialog } from '@mob/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@mob/ui/sheet';
import { Thread } from './Thread';
import { Loading } from './Splash';
import { DeleteConversation } from './DeleteConversation';
import { Sidebar, type View } from './Sidebar';
import { ComposeIcon, MenuIcon } from './icons';
import { pendingOpenRouterSignIn } from './browser/openrouter';
import { cacheScope, forgetSnapshot, keepsMessages, readList, readSnapshot, resume, setKeepsMessages, writeList, writeSnapshot } from './localCache';
import { Notice } from '@mob/ui/notice';

const errorText = (error: unknown) =>
	error instanceof TypeError
		? 'Mob cannot be reached right now; this shows what this browser kept. Start Mob, then refresh.'
		: error instanceof Error
			? error.message
			: String(error);

// Panels load on first use, so the chat opens without their code.
const AgentTree = lazy(() => import('./AgentTree').then((m) => ({ default: m.AgentTree })));
const Plugins = lazy(() => import('./Plugins').then((m) => ({ default: m.Plugins })));
const Usage = lazy(() => import('./Usage').then((m) => ({ default: m.Usage })));
const BrowserLimits = lazy(() => import('./browser/Limits').then((m) => ({ default: m.BrowserLimits })));
const Move = lazy(() => import('./Move').then((m) => ({ default: m.Move })));
const ModelProvider = lazy(() => import('./ModelProvider').then((m) => ({ default: m.ModelProvider })));
const Management = lazy(() => import('./Management').then(m => ({ default: m.Management })));
const panel = <Loading />;

// The address names what the workspace shows: a conversation as #/c/<id>, or a page such as #/usage,
// so reloading or going back returns to it.
const routePrefix = '#/c/';
const pages: Record<string, Exclude<View, 'chat'>> = { '#/agents': 'agents', '#/usage': 'usage', '#/plugins': 'plugins', '#/manage': 'manage' };
const pageTitles: Record<View, string> = { chat: '', manage: 'Manage Mob', agents: 'Agents', usage: 'Token usage', plugins: 'Plugins & cloud services' };
function routedID() {
	return window.location.hash.startsWith(routePrefix) ? decodeURIComponent(window.location.hash.slice(routePrefix.length)) : undefined;
}
const routedView = (): View => window.location.hash.startsWith('#/manage/') ? 'manage' : pages[window.location.hash] ?? 'chat';
const routedManagement = (): ManagementTab => {
	const tab = window.location.hash.slice('#/manage/'.length);
	return ['memories', 'grants', 'schedules', 'projects'].includes(tab) ? tab as ManagementTab : 'memories';
};
function route(hash: string, replace: boolean) {
	if (window.location.hash === hash) return;
	if (replace) window.history.replaceState(window.history.state, '', hash);
	else window.history.pushState(window.history.state, '', hash);
}
/** newConversationID chooses the ID of a new conversation, in the form Mob gives them. */
function newConversationID() {
	return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Recently opened conversations are kept in memory, so switching back shows them at once while they refresh.
const cacheSize = 20;

export function Workspace({
	connection,
	disconnect,
	switchTo,
}: {
	connection: Connection;
	disconnect: () => void;
	/** switchTo opens another Mob, such as the one conversations were just moved to. */
	switchTo?: (connection: Connection) => void;
}) {
	const [managementTab, setManagementTab] = useState<ManagementTab>(routedManagement);
	const [view, setView] = useState<View>(routedView);
	// OpenRouter's sign-in returns to the page with a code, which the provider dialog finishes.
	const [signIn] = useState(() => (connection.browser ? pendingOpenRouterSignIn() : undefined));
	const [provider, setProvider] = useState(!!signIn);
	const [limits, setLimits] = useState(false);
	// A message chosen on another page, such as an example on the empty Agents page, waits in the new conversation's composer.
	const [prompt, setPrompt] = useState('');
	const [moving, setMoving] = useState(false);
	const [navigation, setNavigation] = useState(false);
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [selected, setSelected] = useState<{ id: string; snapshot: Snapshot }>();
	const [error, setError] = useState('');
	const [retry, setRetry] = useState(0);
	const requested = useRef<string>(undefined);
	const drafts = useRef(new Map<string, string>());
	// dispatching is set while the open conversation hands a message to Mob; switching away then could lose it.
	const [dispatching, setDispatching] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [background, setBackground] = useState(false);
	const [keeping, setKeeping] = useState(keepsMessages);
	const scope = cacheScope(connection);
	useEffect(() => resume(scope), [scope]);

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
	// A remembered snapshot is shown before Mob answers, so it never claims a turn is running: that comes from Mob.
	// Deleted conversations are never kept again, though their thread hands its messages over as it closes.
	const deleted = useRef(new Set<string>());
	const remember = (id: string, kept: Snapshot) => {
		if (deleted.current.has(id)) return;
		const snapshot = { ...kept, active: false };
		cache.current.delete(id);
		cache.current.set(id, snapshot);
		if (cache.current.size > cacheSize) cache.current.delete(cache.current.keys().next().value!);
		// A draft nothing was said in has nothing worth keeping on this device.
		if (snapshot.messages.length) void writeSnapshot(scope, id, snapshot);
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
		const list = await api<Conversation[]>(connection, '/conversations');
		setConversations(list);
		void writeList(scope, list);
	}
	function show(id: string, snapshot: Snapshot, replace = false) {
		requested.current = id;
		setSelected({ id, snapshot });
		setView('chat');
		route(routePrefix + encodeURIComponent(id), replace);
		setNavigation(false);
	}
	// page shows one of the workspace's pages beside the conversation, which stays open behind it.
	function page(next: View, replace = false) {
		if (next === 'chat') {
			if (selected) route(routePrefix + encodeURIComponent(selected.id), replace);
		} else route(next === 'manage' ? '#/manage/' + managementTab : Object.keys(pages).find((hash) => pages[hash] === next)!, replace);
		paged(next);
	}
	function manage(tab: ManagementTab) {
		setManagementTab(tab);
		route('#/manage/' + tab, false);
		paged('manage');
	}
	// choice counts the conversations asked for, so a slow response for an earlier one is dropped.
	const choice = useRef(0);
	// viewing counts the pages asked for since, so a conversation that loads after one opens behind it.
	const viewing = useRef(0);
	function paged(next: View) {
		viewing.current++;
		// Going back to the conversation that is open drops one still loading.
		if (next === 'chat') choice.current++;
		setSwitching(false);
		setView(next);
		setNavigation(false);
	}
	// arrive shows a conversation that loaded, unless a page was asked for meanwhile: then it opens behind the page.
	function arrive(id: string, snapshot: Snapshot, since: number, replace: boolean) {
		if (since === viewing.current) show(id, snapshot, replace);
		else setSelected({ id, snapshot });
	}
	// held keeps another conversation from opening while the open one hands a message to Mob, which leaving it could lose.
	const current = useRef(selected?.id);
	current.current = selected?.id;
	const handing = useRef(dispatching);
	handing.current = dispatching;
	const held = (id: string) => handing.current && id !== current.current;
	async function open(id: string, replace = false) {
		if (held(id)) return;
		requested.current = id;
		const ticket = ++choice.current;
		const since = viewing.current;
		setError('');
		// A cached conversation shows at once; its thread reloads the latest messages as it opens.
		// Either way it supersedes a conversation still loading, so switching ends here.
		const cached = cache.current.get(id) ?? (id === selected?.id ? selected.snapshot : undefined);
		setSwitching(!cached);
		if (cached) return show(id, cached, replace);
		try {
			// What this browser kept also shows at once, even while Mob cannot be reached.
			const snapshot = (await readSnapshot(scope, id)) ?? (await load(id));
			if (ticket === choice.current) arrive(id, snapshot, since, replace);
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
		else if (action.kind === 'open-plugins' || action.kind === 'compose-mail') page('plugins');
	}
	// A new conversation is only a draft under an ID chosen here: Mob starts it with its first message, so none is left empty.
	function create(replace = false) {
		if (handing.current) return;
		choice.current++;
		setSwitching(false);
		setError('');
		show(newConversationID(), { messages: [], active: false, model: '' }, replace);
	}
	// A new title shows at once; the list from Mob replaces it if renaming fails.
	function rename(id: string, title: string) {
		setConversations((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
		api(connection, `/conversations/${id}/rename`, { title }).catch((e) => {
			setError(errorText(e));
			void refreshList().catch(() => { /* the error says what went wrong */ });
		});
	}
	const [removing, setRemoving] = useState<Conversation>();
	async function remove(c: Conversation) {
		await api(connection, `/conversations/${c.id}/delete`, {});
		deleted.current.add(c.id);
		setRemoving(undefined);
		cache.current.delete(c.id);
		drafts.current.delete(c.id);
		void forgetSnapshot(scope, c.id);
		const rest = conversations.filter((other) => other.id !== c.id);
		setConversations(rest);
		void writeList(scope, rest);
		// Deleting the open conversation opens the next one, or a new one when none is left.
		if (current.current === c.id) {
			if (rest.length) void open(rest[0].id, true);
			else create(true);
		}
	}
	useEffect(() => {
		let live = true;
		const start = choice.current;
		setError('');
		// A page the address names stays in front of the conversation that opens.
		const showBehind = (id: string, snapshot: Snapshot) => {
			if (routedView() === 'chat') show(id, snapshot, true);
			else setSelected({ id, snapshot });
		};
		const pick = (list: Conversation[]) => {
			const routed = requested.current ?? current.current ?? routedID();
			return routed && list.some((c) => c.id === routed) ? routed : list[0].id;
		};
		// What this browser kept shows first, while the service is asked for the latest.
		const kept = (async () => {
			const list = await readList(scope);
			if (!live || !list?.length) return;
			setConversations((current) => (current.length ? current : list));
			const id = pick(list);
			const snapshot = await readSnapshot(scope, id);
			if (!live || !snapshot || current.current) return;
			cache.current.set(id, snapshot);
			showBehind(id, snapshot);
		})();
		void (async () => {
			try {
				const [list, runtime] = await Promise.all([
					api<Conversation[]>(connection, '/conversations'),
					api<{ background: boolean }>(connection, '/runtime'),
				]);
				await kept;
				if (!live) return;
				setConversations(list);
				void writeList(scope, list);
				setBackground(runtime.background);
				// A conversation the owner picked meanwhile stays open.
				if (choice.current !== start) return;
				// With none yet, a new conversation waits behind the page the address names.
				if (!list.length) showBehind(newConversationID(), { messages: [], active: false, model: '' });
				else if (routedView() !== 'chat') {
					const id = pick(list);
					showBehind(id, cache.current.get(id) ?? (await load(id)));
				} else await open(pick(list), true);
			} catch (e) {
				if (live) setError(errorText(e));
			}
		})();
		return () => {
			live = false;
		};
	}, [connection, retry]);
	// Back and forward move between the conversations and pages the address named.
	const opener = useRef(open);
	opener.current = open;
	const pager = useRef(paged);
	pager.current = paged;
	useEffect(() => {
		const follow = () => {
			const id = routedID();
			if (routedView() !== 'chat') { setManagementTab(routedManagement()); pager.current(routedView()); }
			else if (id && held(id)) route(routePrefix + encodeURIComponent(current.current!), true);
			else if (id && id !== current.current) void opener.current(id, true);
			else pager.current('chat');
		};
		window.addEventListener('popstate', follow);
		return () => window.removeEventListener('popstate', follow);
	}, []);

	// Ctrl+K or ⌘K finds a conversation: the sidebar's search, or the conversation sheet on a phone.
	const search = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const find = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
			e.preventDefault();
			if (search.current?.offsetParent) search.current.focus();
			else setNavigation(true);
		};
		window.addEventListener('keydown', find);
		return () => window.removeEventListener('keydown', find);
	}, []);

	const sidebar = (searchRef?: Ref<HTMLInputElement>) => (
		<Sidebar
			connection={connection}
			conversations={conversations}
			selected={selected?.id}
			view={view}
			locked={dispatching || switching}
			background={background}
			keeping={keeping}
			searchRef={searchRef}
			create={() => create()}
			open={(id) => void open(id)}
			prefetch={prefetch}
			show={page}
			rename={rename}
			remove={(c) => {
				setNavigation(false);
				setRemoving(c);
			}}
			provider={() => { setNavigation(false); setProvider(true); }}
			move={switchTo && isPublicWeb() ? () => { setNavigation(false); setMoving(true); } : undefined}
			limits={connection.browser ? () => { setNavigation(false); setLimits(true); } : undefined}
			keep={(on) => {
				setKeeping(on);
				void setKeepsMessages(on);
			}}
			disconnect={() => { setNavigation(false); disconnect(); }}
		/>
	);
	const title = selected ? conversations.find((c) => c.id === selected.id)?.title || 'New conversation' : '';

	return (
		<div className="workspace">
			<Dialog open={!!removing} onOpenChange={(on) => !on && setRemoving(undefined)}>
				{removing && <DeleteConversation connection={connection} conversation={removing} confirm={() => remove(removing)} cancel={() => setRemoving(undefined)} />}
			</Dialog>
			{moving && switchTo && (
				<Dialog open={moving} onOpenChange={setMoving}>
					<Suspense fallback={null}>
						<Move connection={connection} conversations={conversations} selected={selected?.id} onSwitch={(next) => { setMoving(false); switchTo(next); }} />
					</Suspense>
				</Dialog>
			)}
			{provider && (
				<Suspense fallback={null}>
					<ModelProvider
						connection={connection}
						open={provider}
						onOpenChange={setProvider}
						signIn={signIn}
						onSaved={() => {
							// The open conversation follows the new default, which its picker shows once reloaded.
							if (selected) void load(selected.id).then((snapshot) => show(selected.id, snapshot, true)).catch((e) => setError(errorText(e)));
						}}
					/>
				</Suspense>
			)}
			<aside className="sidebar">{sidebar(search)}</aside>
			<main className="chat-main">
				<div className="mobile-toolbar">
					<Sheet open={navigation} onOpenChange={setNavigation}>
						<SheetTrigger asChild>
							<Button variant="ghost" className="icon-button" aria-label="Conversations">
								<MenuIcon />
							</Button>
						</SheetTrigger>
						<SheetContent className="sidebar-sheet">
							<SheetTitle className="sr-only">Conversations</SheetTitle>
							<SheetDescription className="sr-only">Your conversations, pages and settings.</SheetDescription>
							{sidebar()}
						</SheetContent>
					</Sheet>
					<span className="mobile-title">{view === 'chat' ? title : pageTitles[view]}</span>
					<Button variant="ghost" className="icon-button" aria-label="New conversation" disabled={dispatching || switching} onClick={() => create()}>
						<ComposeIcon />
					</Button>
				</div>
				{connection.browser && (
					<Suspense fallback={null}>
						<BrowserLimits connection={connection} open={limits} setOpen={setLimits} connect={disconnect} />
					</Suspense>
				)}
				{error && (
					<Notice
						tone="error"
						className="workspace-notice"
						actions={
							<Button variant="outline" disabled={dispatching || switching} onClick={() => setRetry((value) => value + 1)}>
								Try again
							</Button>
						}
					>
						{error}
					</Notice>
				)}
				{view === 'agents' && (
					<Suspense fallback={panel}>
						<AgentTree
							connection={connection}
							manage={() => manage('projects')}
							browser={connection.browser}
							changes={changes}
							open={(id) => void refreshList().then(() => open(id)).catch((e) => setError(errorText(e)))}
							held={held}
							start={(text) => {
								setPrompt(text);
								create();
							}}
							connect={connection.browser ? disconnect : undefined}
						/>
					</Suspense>
				)}
				{view === 'manage' && <Suspense fallback={panel}><Management connection={connection} tab={managementTab} select={manage} open={(id) => void refreshList().then(() => open(id)).catch((e) => setError(errorText(e)))} held={held} /></Suspense>}
				{view === 'usage' && (
					<Suspense fallback={panel}>
						<Usage
							connection={connection}
							open={(id) => void refreshList().then(() => open(id)).catch((e) => setError(errorText(e)))}
							held={held}
						/>
					</Suspense>
				)}
				{view === 'plugins' && (
					<Suspense fallback={panel}>
						<Plugins connection={connection} />
					</Suspense>
				)}
				{/* The conversation stays open behind a page, so a reply or a message being sent goes on. */}
				{selected ? (
					<div className="thread-view" hidden={view !== 'chat'}>
						<Thread
							key={selected.id}
							connection={connection}
							id={selected.id}
							initial={selected.snapshot}
							initialInput={drafts.current.get(selected.id)}
							title={title}
							onDispatching={setDispatching}
							onLeave={(snapshot, input) => {
								remember(selected.id, snapshot);
								if (input && !deleted.current.has(selected.id)) drafts.current.set(selected.id, input);
								else drafts.current.delete(selected.id);
							}}
							changes={changes}
							onChanged={() => {
								void refreshList().catch((e) => setError(errorText(e)));
							}}
							onAction={act}
							draft={prompt}
							clearDraft={() => setPrompt('')}
							addProvider={() => setProvider(true)}
							openUsage={() => page('usage')}
						/>
					</div>
				) : (
					view === 'chat' &&
					!error && (
						<Loading label="Opening workspace…" />
					)
				)}
			</main>
		</div>
	);
}
