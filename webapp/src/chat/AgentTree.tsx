import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { Changes } from '@mob/client';
import { api, type Connection } from './api';
import type { AgentApproval, AgentNode } from './contracts';
import { Calf } from '../components/brand/Logo';
import { Button } from '../components/ui/button';
import { BrandIcon, modelBrand, runtimeBrand } from './brandIcons';
import { tokens } from './Usage';
import {
	AlertIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronIcon,
	FileIcon,
	GlobeIcon,
	HandIcon,
	MessageIcon,
	OpenIcon,
	PencilIcon,
	SearchIcon,
	SparkIcon,
	SpinnerIcon,
	StopIcon,
	TerminalIcon,
} from './icons';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Tasks change on their own, so the tree is read again while it is shown.
const refreshEvery = 3000;

export type Branch = { node: AgentNode; children: Branch[]; start: number; end: number };

const live = (status: string) => status === 'running' || status === 'waiting';

// tree nests the nodes by who started whom, the most recently active first.
export function tree(nodes: AgentNode[], now = Date.now()): Branch[] {
	const known = new Set(nodes.map((n) => n.conversationId));
	const children = new Map<string, AgentNode[]>();
	for (const n of nodes) {
		const parent = n.parent && known.has(n.parent) ? n.parent : '';
		children.set(parent, [...(children.get(parent) ?? []), n]);
	}
	const build = (node: AgentNode, seen: Set<string>): Branch => {
		const kids = seen.has(node.conversationId)
			? []
			: (children.get(node.conversationId) ?? []).map((c) => build(c, new Set(seen).add(node.conversationId)));
		const task = node.task;
		const start = Math.min(task?.createdAt ?? Infinity, ...kids.map((k) => k.start));
		const end = Math.max(task ? (live(node.status) ? now : task.updatedAt) : 0, ...kids.map((k) => k.end));
		return { node, children: kids.sort((a, b) => b.end - a.end), start, end };
	};
	return (children.get('') ?? []).map((n) => build(n, new Set())).sort((a, b) => b.end - a.end);
}

export function duration(ms: number) {
	if (!Number.isFinite(ms) || ms < 0) return '';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// cost is a price in dollars, with a tenth of a cent below a dollar.
export const cost = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

// spent says what a node's conversation used: its cost when priced, and its tokens.
function spent(usage: AgentNode['usage']) {
	if (!usage?.totalTokens) return '';
	return `${usage.cost > 0 ? `${cost(usage.cost)} · ` : ''}${tokens(usage.totalTokens)} tokens`;
}

// usageTitle breaks the tokens down for a card's tooltip.
function usageTitle(usage: NonNullable<AgentNode['usage']>) {
	const lines = [
		`${tokens(usage.inputTokens)} input, ${tokens(usage.cacheReadTokens)} read from the cache, ${tokens(usage.cacheWriteTokens)} written to it`,
		`${tokens(usage.outputTokens)} output, ${tokens(usage.reasoningTokens)} reasoning`,
		...usage.models.map((m) => `${m.model}: ${tokens(m.totalTokens)}${m.cost > 0 ? ` · ${cost(m.cost)}` : ''}`),
	];
	return lines.join('\n');
}

// descendants counts the agents under branch.
const descendants = (b: Branch): number => b.children.reduce((n, c) => n + 1 + descendants(c), 0);

type Filter = 'running' | 'waiting' | 'failed';

const statuses: Record<string, { label: string; icon?: ReactNode }> = {
	running: { label: 'Running', icon: <SpinnerIcon /> },
	waiting: { label: 'Needs you', icon: <HandIcon /> },
	review: { label: 'Done', icon: <CheckIcon /> },
	failed: { label: 'Failed', icon: <AlertIcon /> },
	stopped: { label: 'Stopped' },
	idle: { label: 'Idle' },
};

const tools: Record<string, ReactNode> = {
	execute: <TerminalIcon />,
	edit: <PencilIcon />,
	delete: <PencilIcon />,
	move: <PencilIcon />,
	read: <FileIcon />,
	search: <SearchIcon />,
	fetch: <GlobeIcon />,
	think: <SparkIcon />,
};

function Avatar({ agent }: { agent: string }) {
	if (agent === 'mob')
		return (
			<span className="agent-avatar mob" title="Mob">
				<Calf size={18} />
			</span>
		);
	const brand = runtimeBrand(agent);
	return (
		<span className="agent-avatar">
			{brand ? <BrandIcon brand={brand} size={18} /> : <span aria-hidden="true">{agent.slice(0, 2)}</span>}
		</span>
	);
}

// What the owner can do from a card; each resolves once the service took it.
export type Act = {
	decide: (conversationId: string, approval: string, approved: boolean, extra?: { reason?: string; remember?: string }) => Promise<unknown>;
	stop: (node: AgentNode) => Promise<unknown>;
	message: (taskId: string, text: string) => Promise<unknown>;
};

// shownApprovals bounds the decisions a card offers; the rest wait in the conversation.
const shownApprovals = 2;

function Decision({ node, approval, act, busy }: { node: AgentNode; approval: AgentApproval; act: Act; busy: boolean }) {
	const [denying, setDenying] = useState(false);
	const [reason, setReason] = useState('');
	const decide = (approved: boolean, extra?: { reason?: string; remember?: string }) => act.decide(node.conversationId, approval.id, approved, extra);
	const deny = (e: FormEvent) => {
		e.preventDefault();
		void decide(false, { reason: reason.trim() || undefined });
	};
	return (
		<div className="agent-approval">
			<p className="agent-approval-tool">{approval.tool}</p>
			{approval.text && <pre className="agent-approval-text">{approval.text}</pre>}
			{!approval.whole && <p className="agent-more">Too long to show here; open its conversation to approve it.</p>}
			{denying ? (
				<form className="agent-inline" onSubmit={deny}>
					<input aria-label="Why deny (optional)" placeholder="Why? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus disabled={busy} />
					<button type="submit" className="agent-button deny" disabled={busy}>
						Deny
					</button>
					<button type="button" className="agent-button" onClick={() => setDenying(false)} disabled={busy}>
						Cancel
					</button>
				</form>
			) : (
				<div className="agent-approval-actions">
					{approval.whole && (
						<>
							<button type="button" className="agent-button approve" disabled={busy} onClick={() => void decide(true)}>
								Approve
							</button>
							<button type="button" className="agent-button" disabled={busy} title="Approve, and allow the same request without asking from now on" onClick={() => void decide(true, { remember: 'always' })}>
								Always allow
							</button>
						</>
					)}
					<button type="button" className="agent-button deny" disabled={busy} onClick={() => setDenying(true)}>
						Deny…
					</button>
				</div>
			)}
		</div>
	);
}

function Instruct({ send, busy, done }: { send: (text: string) => Promise<boolean>; busy: boolean; done: () => void }) {
	const [text, setText] = useState('');
	const submit = (e: FormEvent) => {
		e.preventDefault();
		// A send that failed keeps the text to try again.
		if (text.trim()) void send(text.trim()).then((sent) => sent && done());
	};
	return (
		<form className="agent-inline" onSubmit={submit}>
			<input aria-label="Instruction for the agent" placeholder="Tell the agent…" value={text} onChange={(e) => setText(e.target.value)} autoFocus disabled={busy} />
			<button type="submit" className="agent-button approve" disabled={busy || !text.trim()}>
				Send
			</button>
		</form>
	);
}

function Card({
	branch,
	open,
	collapsed,
	toggle,
	act,
}: {
	branch: Branch;
	open: (conversationId: string) => void;
	collapsed: boolean;
	toggle: () => void;
	act: Act;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState('');
	const [instructing, setInstructing] = useState(false);
	// Every action shows it is under way and what went wrong, if anything did.
	const run =
		<A extends unknown[]>(f: (...args: A) => Promise<unknown>) =>
		async (...args: A) => {
			setBusy(true);
			setFailure('');
			try {
				await f(...args);
				return true;
			} catch (e) {
				setFailure(errorText(e));
				return false;
			} finally {
				setBusy(false);
			}
		};
	const message = run(act.message);
	const actions: Act = { decide: run(act.decide), stop: run(act.stop), message };
	const { node, children } = branch;
	const status = statuses[node.status] ?? { label: node.status };
	const plan = node.task?.plan ?? [];
	const done = plan.filter((p) => p.status === 'completed').length;
	const shown = node.tools.filter((t) => tools[t]).slice(0, 4);
	const model = modelBrand(node.model, node.agent);
	const hidden = collapsed ? descendants(branch) : 0;
	// Clicking a card with agents under it folds them; its buttons do their own thing.
	const click = (e: MouseEvent) => {
		if (children.length && !(e.target as Element).closest('button, input, form, .agent-approval')) toggle();
	};
	return (
		<article
			className="agent-card"
			data-node={node.conversationId}
			data-status={node.status}
			data-folds={children.length > 0 || undefined}
			data-collapsed={collapsed || undefined}
			onClick={click}
		>
			<header>
				<Avatar agent={node.agent} />
				<div className="agent-name">
					<strong>{node.label}</strong>
					<small className="agent-model" title={node.model}>
						{model && <BrandIcon brand={model} size={12} />}
						{node.model || (node.agent === 'mob' ? 'Project manager' : 'Model not reported')}
					</small>
				</div>
				<span className="agent-status" data-status={node.status}>
					{status.icon}
					{status.label}
					{node.approvals.length > 1 && ` · ${node.approvals.length}`}
				</span>
			</header>
			<p className="agent-task">
				{shown.length > 0 && (
					<span className="agent-tools" title={`Used ${shown.join(', ')}`}>
						{shown.map((t) => (
							<span key={t}>{tools[t]}</span>
						))}
					</span>
				)}
				{node.title}
			</p>
			{node.task && (
				<p className="agent-branch-name" title={node.task.readOnly ? `Reads ${node.task.worktree} without changing it` : node.task.worktree}>
					{node.task.readOnly && <span className="agent-readonly">Read-only</span>}
					{node.task.project} · {node.task.branch}
				</p>
			)}
			{plan.length > 0 && (
				<div className="agent-plan" title={plan.map((p) => `${p.status === 'completed' ? '✓' : '·'} ${p.content}`).join('\n')}>
					<span style={{ width: `${(done / plan.length) * 100}%` }} />
				</div>
			)}
			{node.approvals.slice(0, shownApprovals).map((a) => (
				<Decision key={a.id} node={node} approval={a} act={actions} busy={busy} />
			))}
			{node.approvals.length > shownApprovals && (
				<p className="agent-more">{node.approvals.length - shownApprovals} more wait in its conversation.</p>
			)}
			{instructing && node.task && <Instruct send={(text) => message(node.task!.id, text)} busy={busy} done={() => setInstructing(false)} />}
			{failure && (
				<p className="agent-failure" role="alert">
					{failure}
				</p>
			)}
			<footer>
				<span className="agent-spent" title={node.usage ? usageTitle(node.usage) : undefined}>
					{node.usage?.totalTokens ? <strong>{spent(node.usage)}</strong> : null}
					{[plan.length > 0 && `${done}/${plan.length} steps`, duration(branch.end - branch.start)]
						.filter(Boolean)
						.map((part, i) => (node.usage?.totalTokens || i > 0 ? ` · ${part}` : part))
						.join('')}
				</span>
				<span className="agent-actions">
					{node.task && (
						<button
							type="button"
							className="agent-open"
							aria-label={`Instruct ${node.label}: ${node.title}`}
							aria-pressed={instructing}
							title="Tell the agent what to do next"
							onClick={() => setInstructing(!instructing)}
						>
							<MessageIcon />
						</button>
					)}
					{live(node.status) && (
						<button
							type="button"
							className="agent-open"
							aria-label={`Stop ${node.label}: ${node.title}`}
							title={node.task ? 'Stop the agent; its branch stays' : 'Stop this turn'}
							disabled={busy}
							onClick={() => void actions.stop(node)}
						>
							<StopIcon />
						</button>
					)}
					<button type="button" className="agent-open" aria-label={`Open ${node.label}: ${node.title}`} title="Open its conversation" onClick={() => open(node.conversationId)}>
						<OpenIcon />
					</button>
					{children.length > 0 && (
						<button
							type="button"
							className="agent-toggle"
							aria-expanded={!collapsed}
							aria-label={`${collapsed ? 'Show' : 'Hide'} ${descendants(branch)} agents started by ${node.label}`}
							onClick={toggle}
						>
							{collapsed ? `+${hidden}` : children.length} {collapsed ? <ChevronIcon /> : <ChevronDownIcon />}
						</button>
					)}
				</span>
			</footer>
		</article>
	);
}

function Subtree({
	branch,
	depth,
	open,
	collapsed,
	toggle,
	act,
}: {
	branch: Branch;
	depth: number;
	open: (conversationId: string) => void;
	collapsed: Set<string>;
	toggle: (id: string) => void;
	act: Act;
}) {
	const id = branch.node.conversationId;
	const shut = collapsed.has(id);
	return (
		<li className="agent-branch">
			<Card branch={branch} open={open} collapsed={shut} toggle={() => toggle(id)} act={act} />
			{!shut && branch.children.length > 0 && (
				<ul className={depth === 0 ? 'agent-children row' : 'agent-children'}>
					{branch.children.map((c) => (
						<Subtree key={c.node.conversationId} branch={c} depth={depth + 1} open={open} collapsed={collapsed} toggle={toggle} act={act} />
					))}
				</ul>
			)}
		</li>
	);
}

// prune keeps the branches with a node that passes the filter, and their parents.
function prune(branches: Branch[], keep: (n: AgentNode) => boolean): Branch[] {
	return branches.flatMap((b) => {
		const children = prune(b.children, keep);
		return keep(b.node) || children.length ? [{ ...b, children }] : [];
	});
}

export type Link = { id: string; status: string; d: string; x: number; y: number };

type Box = { left: number; top: number; right: number; bottom: number };

// link draws the line from a parent's card to a child's with rounded
// corners. A child fanned out in a row beside others is reached from the
// parent's bottom centre, across and down to its top centre; a child hanging
// below its parent is reached down the parent's left side and across.
export function link(parent: Box, child: Box, fan: boolean): { d: string; x: number; y: number } {
	if (!fan) {
		const x = parent.left + 22;
		const y = child.top + 22;
		const r = Math.max(0, Math.min(10, (y - parent.bottom) / 2, (child.left - x) / 2));
		return { d: `M${x} ${parent.bottom}V${y - r}Q${x} ${y} ${x + r} ${y}H${child.left}`, x, y: parent.bottom };
	}
	const x = (parent.left + parent.right) / 2;
	const cx = (child.left + child.right) / 2;
	const mid = (parent.bottom + child.top) / 2;
	const r = Math.min(10, Math.abs(cx - x) / 2, (child.top - parent.bottom) / 2);
	if (r < 1) return { d: `M${x} ${parent.bottom}V${child.top}`, x, y: parent.bottom };
	const s = cx > x ? 1 : -1;
	return {
		d: `M${x} ${parent.bottom}V${mid - r}Q${x} ${mid} ${x + s * r} ${mid}H${cx - s * r}Q${cx} ${mid} ${cx} ${mid + r}V${child.top}`,
		x,
		y: parent.bottom,
	};
}

// Links draws who started whom between the cards shown in canvas.
function Links({ canvas, edges, version }: { canvas: RefObject<HTMLDivElement | null>; edges: [string, string, string][]; version: string }) {
	const [links, setLinks] = useState<Link[]>([]);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const root = canvas.current;
		if (!root) return;
		const measure = () => {
			const origin = root.getBoundingClientRect();
			const card = (id: string) => root.querySelector(`[data-node="${CSS.escape(id)}"]`);
			const box = (el: Element): Box => {
				const r = el.getBoundingClientRect();
				return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top };
			};
			const next: Link[] = [];
			for (const [parent, child, status] of edges) {
				const from = card(parent);
				const to = card(child);
				if (!from || !to) continue;
				// Phones stack a row's children in a column.
				const row = to.closest('ul');
				const fan = !!row?.classList.contains('row') && getComputedStyle(row).flexDirection === 'row';
				next.push({ id: `${parent}>${child}`, status, ...link(box(from), box(to), fan) });
			}
			setLinks(next);
			setSize({ width: root.scrollWidth, height: root.scrollHeight });
		};
		measure();
		const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
		observer?.observe(root);
		window.addEventListener('resize', measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', measure);
		};
	}, [canvas, version]);
	return (
		<svg className="agent-links" width={size.width} height={size.height} aria-hidden="true">
			<defs>
				{Object.keys(statuses).map((s) => (
					<marker key={s} id={`agent-arrow-${s}`} className="agent-arrow" data-status={s} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
						<path d="M0 0L8 4L0 8Z" />
					</marker>
				))}
			</defs>
			{links.map((l) => (
				<g key={l.id} className="agent-link" data-status={l.status}>
					<path d={l.d} markerEnd={`url(#agent-arrow-${statuses[l.status] ? l.status : 'idle'})`} />
					{live(l.status) && <path className="agent-flow" d={l.d} />}
					<circle cx={l.x} cy={l.y} r="3" />
				</g>
			))}
		</svg>
	);
}

// edges lists [parent, child, child's status] for every link shown.
function edges(branches: Branch[], collapsed: Set<string>): [string, string, string][] {
	return branches.flatMap((b) =>
		collapsed.has(b.node.conversationId)
			? []
			: [
					...b.children.map((c): [string, string, string] => [b.node.conversationId, c.node.conversationId, c.node.status]),
					...edges(b.children, collapsed),
				],
	);
}

export function AgentTree({
	connection,
	changes,
	open,
	close,
}: {
	connection: Connection;
	/** changes, while live, replaces refreshing on a timer: the tree reloads when something changed. */
	changes?: Changes;
	open: (conversationId: string) => void;
	close: () => void;
}) {
	const [nodes, setNodes] = useState<AgentNode[]>();
	const [error, setError] = useState('');
	const [filter, setFilter] = useState<Filter>();
	const [collapsed, setCollapsed] = useState(new Set<string>());
	const [now, setNow] = useState(Date.now());
	const canvas = useRef<HTMLDivElement>(null);
	const reload = useRef(() => {});

	useEffect(() => {
		let alive = true;
		const load = () =>
			api<AgentNode[]>(connection, '/tasks')
				.then((list) => {
					if (!alive) return;
					setNodes(list);
					setNow(Date.now());
					setError('');
				})
				.catch((e) => alive && setError(errorText(e)));
		reload.current = () => void load();
		void load();
		// A hidden page stops refreshing and catches up when it is shown again.
		const shown = () => {
			if (!document.hidden) void load();
		};
		document.addEventListener('visibilitychange', shown);
		// While changes are live, the timer only keeps the times shown current.
		const timer = setInterval(() => {
			if (document.hidden) return;
			if (changes?.live) setNow(Date.now());
			else void load();
		}, refreshEvery);
		// A tree shows tasks and their conversations, so any change reloads it: at most once a second, and
		// never postponed, so continuous activity still refreshes it.
		let soon: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = changes?.subscribe(() => {
			soon ??= setTimeout(() => {
				soon = undefined;
				void load();
			}, 1000);
		});
		return () => {
			alive = false;
			clearInterval(timer);
			clearTimeout(soon);
			unsubscribe?.();
			document.removeEventListener('visibilitychange', shown);
		};
	}, [connection, changes]);

	// An action changes the tree at once, and again when the turn it starts gets going.
	const post = async (path: string, body: object) => {
		await api(connection, path, body);
		reload.current();
		setTimeout(() => reload.current(), 1000);
	};
	const act: Act = {
		decide: (conversationId, approval, approved, extra) => post(`/conversations/${conversationId}/decide`, { id: approval, approved, ...extra }),
		stop: (node) => post(node.task ? `/tasks/${node.task.id}/stop` : `/conversations/${node.conversationId}/stop`, {}),
		message: (task, text) => post(`/tasks/${task}/message`, { text }),
	};

	const all = nodes ?? [];
	const count = (status: string) => all.filter((n) => n.status === status).length;
	const branches = tree(all, now);
	const shown = filter ? prune(branches, (n) => n.status === filter) : branches;
	const lines = edges(shown, collapsed);
	const total = all.reduce((sum, n) => ({ cost: sum.cost + (n.usage?.cost ?? 0), tokens: sum.tokens + (n.usage?.totalTokens ?? 0) }), { cost: 0, tokens: 0 });
	const chip = (status: Filter, label: string) => {
		const n = count(status);
		if (!n && filter !== status) return null;
		return (
			<button
				type="button"
				className="agents-filter"
				data-status={status}
				aria-pressed={filter === status}
				onClick={() => setFilter(filter === status ? undefined : status)}
			>
				{n} {label}
			</button>
		);
	};
	const toggle = (id: string) =>
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	return (
		<section className="agents" aria-label="Agents">
			<header className="agents-header">
				<h1>
					<SparkIcon /> Agents
				</h1>
				<div className="agents-summary">
					<span>
						{all.length} {all.length === 1 ? 'agent' : 'agents'}
					</span>
					{chip('running', 'running')}
					{chip('waiting', 'needs you')}
					{chip('failed', 'failed')}
					{total.tokens > 0 && (
						<strong className="agents-total" title={`${tokens(total.tokens)} tokens in all`}>
							{total.cost > 0 ? cost(total.cost) : `${tokens(total.tokens)} tokens`}
						</strong>
					)}
				</div>
				<Button variant="outline" className="small agents-back" onClick={close}>
					Back to chat
				</Button>
			</header>
			{error && (
				<div className="error" role="alert">
					{error}
				</div>
			)}
			{!nodes && !error && (
				<div className="loading" role="status">
					Loading agents…
				</div>
			)}
			{nodes && !all.length && (
				<p className="agents-empty">
					No tasks yet. Ask Mob to hand coding work in a project to a coding agent; each task shows here under the conversation that
					started it.
				</p>
			)}
			<div className="agents-canvas" ref={canvas}>
				<Links canvas={canvas} edges={lines} version={`${lines.map((l) => l.join(':')).join(',')} ${filter ?? ''} ${now}`} />
				<ul className="agents-tree">
					{shown.map((b) => (
						<Subtree key={b.node.conversationId} branch={b} depth={0} open={open} collapsed={collapsed} toggle={toggle} act={act} />
					))}
				</ul>
			</div>
		</section>
	);
}
