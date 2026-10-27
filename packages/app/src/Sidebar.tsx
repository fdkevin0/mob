import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { isPublicWeb, type Connection, type Conversation } from './api';
import { Logo } from '@mob/ui/brand/Logo';
import { Button } from '@mob/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '@mob/ui/dropdown-menu';
import { CheckboxItem, Separator } from '@radix-ui/react-dropdown-menu';
import { ThemePicker } from '@mob/ui/ThemePicker';
import {
	AgentsIcon,
	BrowserIcon,
	ChartIcon,
	CheckIcon,
	ChevronsIcon,
	ComposeIcon,
	HomeIcon,
	InfoIcon,
	KeyIcon,
	MoreIcon,
	MoveIcon,
	PlugIcon,
	RaisedHandIcon,
	RenameIcon,
	RunnerIcon,
	SearchIcon,
	SwitchIcon,
	TrashIcon,
	UserIcon,
} from './icons';

/** View is what the workspace's main area shows: the open conversation, or one of the workspace's pages. */
export type View = 'chat' | 'agents' | 'usage' | 'plugins';

const day = 24 * 60 * 60 * 1000;
/**
 * groups puts conversations, newest first, under how long ago they changed: today, yesterday, this week, this month, or earlier.
 * A conversation without a time counts as today.
 */
export function groups(list: Conversation[], now = Date.now()): { label: string; conversations: Conversation[] }[] {
	const midnight = new Date(now).setHours(0, 0, 0, 0);
	const bounds: [string, number][] = [
		['Today', midnight],
		['Yesterday', midnight - day],
		['Previous 7 days', midnight - 6 * day],
		['Previous 30 days', midnight - 29 * day],
		['Earlier', -Infinity],
	];
	const out = bounds.map(([label]) => ({ label, conversations: [] as Conversation[] }));
	for (const c of list) out[bounds.findIndex(([, since]) => (c.updatedAt ?? now) >= since)].conversations.push(c);
	return out.filter((g) => g.conversations.length);
}

/** where says which Mob this is and where its history lives, as the runner menu shows it. */
function where(connection: Connection, background: boolean) {
	if (connection.browser) return { name: 'This browser', detail: 'Stops with this tab', icon: <BrowserIcon /> };
	if (connection.runner) return { name: 'Remote runner', detail: 'History stays on your runner', icon: <RunnerIcon /> };
	return { name: 'This computer', detail: background ? 'Keeps running in the background' : 'Stops with its process', icon: <RunnerIcon /> };
}

export function Sidebar({
	connection,
	conversations,
	selected,
	view,
	locked,
	background,
	keeping,
	searchRef,
	create,
	open,
	prefetch,
	show,
	rename,
	remove,
	provider,
	move,
	limits,
	keep,
	disconnect,
}: {
	connection: Connection;
	conversations: Conversation[];
	selected?: string;
	view: View;
	/** locked is set while the open conversation hands a message to Mob, which leaving it could lose. */
	locked: boolean;
	background: boolean;
	keeping: boolean;
	searchRef?: Ref<HTMLInputElement>;
	create: () => void;
	open: (id: string) => void;
	prefetch: (id: string) => void;
	show: (view: View) => void;
	/** rename gives a conversation a title; remove asks to delete one. */
	rename: (id: string, title: string) => void;
	remove: (conversation: Conversation) => void;
	/** provider, move and limits open their dialogs; each is offered only where the Mob has it. */
	provider?: () => void;
	move?: () => void;
	limits?: () => void;
	keep: (on: boolean) => void;
	disconnect: () => void;
}) {
	const [query, setQuery] = useState('');
	const found = useMemo(() => {
		const q = query.trim().toLowerCase();
		return groups(q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations);
	}, [conversations, query]);
	const here = where(connection, background);
	const page = (name: Exclude<View, 'chat'>, label: string, icon: ReactNode) => (
		<Button variant="ghost" className="sidebar-link" aria-current={view === name ? 'page' : undefined} onClick={() => show(name)}>
			{icon}
			<span>{label}</span>
		</Button>
	);
	return (
		<>
			<div className="sidebar-brand">
				<Logo size={26} />
				<Button
					variant="ghost"
					className="icon-button"
					aria-label="New conversation"
					title="New conversation"
					disabled={locked}
					onClick={create}
				>
					<ComposeIcon />
				</Button>
			</div>
			<label className="sidebar-search">
				<SearchIcon />
				<input
					ref={searchRef}
					type="search"
					aria-label="Search conversations"
					placeholder="Search conversations"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') setQuery('');
					}}
				/>
				<kbd aria-hidden="true">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
			</label>
			<nav aria-label="Conversations" className="conversation-list">
				{found.map((g) => (
					<section key={g.label} aria-label={g.label}>
						<h2 className="conversation-group">{g.label}</h2>
						{g.conversations.map((c) => (
							<Row
								key={c.id}
								conversation={c}
								current={view === 'chat' && selected === c.id}
								disabled={locked && selected !== c.id}
								open={() => open(c.id)}
								prefetch={() => prefetch(c.id)}
								rename={(title) => rename(c.id, title)}
								remove={() => remove(c)}
							/>
						))}
					</section>
				))}
				{query && !found.length && <p className="conversation-none">No conversation is called “{query.trim()}”.</p>}
			</nav>
			<div className="sidebar-pages">
				{page('agents', 'Agents', <AgentsIcon />)}
				{page('usage', 'Token usage', <ChartIcon />)}
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" className="runner-button" aria-label={`${here.name}: settings and runner`}>
						<span className="runner-icon">{here.icon}</span>
						<span className="runner-text">
							<strong>{here.name}</strong>
							<small>{here.detail}</small>
						</span>
						<ChevronsIcon />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent className="runner-menu" side="top" align="start" sideOffset={6}>
					<DropdownMenuLabel className="ui-menu-label">
						<strong>{here.name}</strong>
						{connection.browser
							? 'Mob runs in this tab, one tab at a time'
							: `History stays ${connection.runner ? 'on your runner' : 'on this computer'}`}
					</DropdownMenuLabel>
					{/* A provider is added here as well as with `mob provider add`, which the browser runner does not have. */}
					{provider && <Item icon={<KeyIcon />} label="Model providers" onSelect={provider} />}
					{/* Channels and cloud services run in the background, which a browser tab cannot. */}
					{!connection.browser && <Item icon={<PlugIcon />} label="Plugins & cloud services" onSelect={() => show('plugins')} />}
					{move && <Item icon={<MoveIcon />} label="Move conversations" onSelect={move} />}
					{limits && <Item icon={<InfoIcon />} label="What needs a runner" onSelect={limits} />}
					{/* The browser runner's history is already in this browser. */}
					{!connection.browser && (
						<CheckboxItem
							className="ui-menu-item menu-check"
							checked={keeping}
							onCheckedChange={(on) => keep(on === true)}
							onSelect={(e) => e.preventDefault()}
							title="Conversation titles are always kept in this browser so Mob opens at once. Messages are kept only when this is on; turning it off forgets them."
						>
							<span className="menu-check-box">{keeping && <CheckIcon />}</span>
							Keep messages on this device
						</CheckboxItem>
					)}
					<div className="menu-row">
						Theme <ThemePicker />
					</div>
					<Separator className="menu-separator" />
					{isPublicWeb() && (
						<>
							<DropdownMenuItem className="ui-menu-item" asChild>
								<a href="/">
									<HomeIcon /> Mob home
								</a>
							</DropdownMenuItem>
							<DropdownMenuItem className="ui-menu-item" asChild>
								<a href="/account">
									<UserIcon /> Account
								</a>
							</DropdownMenuItem>
						</>
					)}
					<Item icon={<SwitchIcon />} label={connection.browser ? 'Connect a runner' : 'Disconnect'} onSelect={disconnect} />
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}

/** Row is one conversation in the list, with a menu to rename or delete it; renaming edits the title in place. */
function Row({
	conversation: c,
	current,
	disabled,
	open,
	prefetch,
	rename,
	remove,
}: {
	conversation: Conversation;
	current: boolean;
	disabled: boolean;
	open: () => void;
	prefetch: () => void;
	rename: (title: string) => void;
	remove: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (editing) field.current?.select();
	}, [editing]);
	if (editing) {
		const save = () => {
			const title = field.current?.value.replace(/\s+/g, ' ').trim() ?? '';
			setEditing(false);
			if (title && title !== c.title) rename(title);
		};
		return (
			<form
				className="conversation-row editing"
				onSubmit={(e) => {
					e.preventDefault();
					save();
				}}
			>
				<input
					ref={field}
					className="conversation-rename"
					aria-label="Conversation title"
					defaultValue={c.title}
					maxLength={200}
					onBlur={save}
					onKeyDown={(e) => {
						if (e.key === 'Escape') setEditing(false);
					}}
				/>
			</form>
		);
	}
	return (
		<div className="conversation-row" data-current={current || undefined}>
			<Button
				variant="ghost"
				className="conversation-link"
				aria-current={current ? 'page' : undefined}
				disabled={disabled}
				onClick={open}
				onPointerEnter={prefetch}
				onFocus={prefetch}
			>
				<span className="conversation-title">{c.title}</span>
				{c.waiting ? (
					<span className="conversation-mark waiting" title="Waiting for your approval">
						<RaisedHandIcon />
						<span className="sr-only">Waiting for your approval</span>
					</span>
				) : (
					c.active && (
						<span className="conversation-mark running" title="Replying">
							<span className="run-dot" />
							<span className="sr-only">Replying</span>
						</span>
					)
				)}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" className="icon-button conversation-more" aria-label={`More for ${c.title}`} title="Rename or delete">
						<MoreIcon />
					</Button>
				</DropdownMenuTrigger>
				{/* The title field takes the focus a closing menu would give back to this button. */}
				<DropdownMenuContent className="runner-menu conversation-menu" align="start" sideOffset={4} onCloseAutoFocus={(e) => e.preventDefault()}>
					<Item icon={<RenameIcon />} label="Rename" onSelect={() => setEditing(true)} />
					{/* Mob refuses to delete a conversation while it replies there. */}
					<DropdownMenuItem className="ui-menu-item danger" disabled={c.active} onSelect={remove}>
						<TrashIcon /> Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

function Item({ icon, label, onSelect }: { icon: ReactNode; label: string; onSelect: () => void }) {
	return (
		<DropdownMenuItem className="ui-menu-item" onSelect={onSelect}>
			{icon} {label}
		</DropdownMenuItem>
	);
}
