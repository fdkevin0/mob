import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Changes } from '@mob/client';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mob/ui/dialog';
import { api, type Connection } from './api';
import type { AgentNode } from './contracts';
import { nodeStatus } from './AgentTree';
import { CheckIcon, EyeIcon, HandIcon, OpenIcon, SpinnerIcon, TerminalIcon, UserIcon } from './icons';

/** Stage is a step a blueprint runs after the agent's work: the project's checks, or another agent's review. */
type Stage = { type: 'verify'; retries: number } | { type: 'review'; aspects: string[]; rounds: number };
/** PlanBlueprint is what a blueprint does; plans asked before the card drew them say it in a line only. */
type PlanBlueprint = string | { does: string; stages: Stage[]; manual?: boolean };

/** PlanInput is what task_plan asks the owner to approve: tasks in one project, and what each blueprint does. */
export type PlanInput = {
	project?: string;
	summary?: string;
	tasks?: { title?: string; agent?: string; blueprint?: string; prompt?: string }[];
	blueprints?: Record<string, PlanBlueprint>;
};
/** PlanOutput is what an approved plan started. */
type PlanOutput = { tasks?: { task: string; conversation: string; title: string; agent: string; branch: string }[]; failed?: string[] };
type Run = NonNullable<PlanOutput['tasks']>[number];
type PlanTask = NonNullable<PlanInput['tasks']>[number];

// Started tasks change on their own; while changes are not live, the card reads them again this often.
const refreshEvery = 5000;

/** Step is a node of a task's lane: the agent builds, the blueprint's stages run, and the task is ready. */
type StepKind = 'build' | 'verify' | 'review' | 'model' | 'ready';
/** State is where a started task is at a step. */
type State = 'idle' | 'run' | 'wait' | 'done' | 'fail';
type Step = { kind: StepKind; label: string; title: string; sub: string; does: string; state: State; now?: string; stage?: Stage };
type Lane = { task: PlanTask; run?: Run; node?: AgentNode; steps: Step[] };

const kindLabels: Record<StepKind, string> = { build: 'Agent', verify: 'Checks', review: 'Review', model: 'Mob checks', ready: 'Ready' };
const pillLabels: Record<StepKind, string> = { build: 'Build', verify: 'Checks', review: 'Review', model: 'Mob', ready: 'Ready' };

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * PlanCard shows a plan Mob proposes as the work it starts: one row per task
 * with the steps its blueprint runs, and, on demand, the plan drawn as a flow
 * whose steps say what they do. Once approved, each step shows where its task
 * is, and a task opens its conversation.
 */
export function PlanCard({
	connection,
	changes,
	input,
	output,
	state,
	open,
	children,
}: {
	connection: Connection;
	changes?: Changes;
	input: PlanInput;
	output?: unknown;
	/** state is the call's: its icon and label. */
	state: { kind: string; label: string; icon: ReactNode };
	open: (conversationId: string) => void;
	/** children decide the plan while it waits for the owner. */
	children?: ReactNode;
}) {
	const started = (output as PlanOutput | undefined)?.tasks ?? [];
	const nodes = useTasks(
		connection,
		changes,
		started.map((t) => t.conversation),
	);
	const [flow, setFlow] = useState<string | undefined>();
	const tasks = input.tasks ?? [];
	const project = (input.project ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
	// Tasks start in plan order, so each started task is the next of the plan's with its title and agent; one that failed to start is skipped.
	let next = 0;
	const lanes: Lane[] = tasks.map((task) => {
		const s = started[next];
		const run = s && s.title === task.title && s.agent === task.agent ? started[next++] : undefined;
		const node = run && nodes.find((n) => n.conversationId === run.conversation);
		return { task, run, node, steps: steps(task, input.blueprints?.[task.blueprint ?? ''], project, node) };
	});
	const title = `Plan · ${plural(tasks.length, 'task')}${project ? ` in ${project}` : ''}`;
	return (
		<section className={`plan-card ${state.kind}`} aria-label="Plan">
			<header>
				<span className="tool-status" title={state.label}>
					{state.icon}
				</span>
				<strong>{title}</strong>
				<span className="sr-only">{state.label}</span>
				<button type="button" className="plan-open-flow" onClick={() => setFlow('0.build')}>
					<FlowIcon /> Open as flow
				</button>
			</header>
			{input.summary && <p className="plan-summary">{input.summary}</p>}
			<ol className="plan-tasks">
				{lanes.map((lane, i) => {
					const status = lane.node && nodeStatus(lane.node);
					return (
						<li key={i} data-status={lane.node?.status} data-stage={status?.stage}>
							<button type="button" className="plan-task-main" onClick={() => setFlow(`${i}.build`)} title="Show its steps">
								<span className="plan-task-n">{i + 1}</span>
								<span className="plan-task-text">
									<span className="plan-task-title">{lane.task.title}</span>
									<span className="plan-task-meta">
										{[lane.task.agent, blueprintLabel(input.blueprints?.[lane.task.blueprint ?? '']), lane.run?.branch]
											.filter(Boolean)
											.join(' · ')}
									</span>
								</span>
								<span className="plan-mini" aria-hidden="true">
									{lane.steps.map((s) => (
										<span key={s.kind} className="plan-pill" data-state={s.state}>
											<i />
											{pillLabels[s.kind]}
										</span>
									))}
								</span>
							</button>
							{lane.run && (
								<button
									type="button"
									className="plan-task-status"
									onClick={() => open(lane.run!.conversation)}
									title="Open its conversation"
								>
									{status?.icon}
									{status?.label ?? 'Started'}
								</button>
							)}
						</li>
					);
				})}
			</ol>
			{(output as PlanOutput | undefined)?.failed?.map((f) => (
				<p key={f} className="plan-failed" role="alert">
					Did not start: {f}
				</p>
			))}
			{children}
			<Dialog open={flow !== undefined} onOpenChange={(show) => !show && setFlow(undefined)}>
				<DialogContent className="plan-flow-dialog" aria-describedby={undefined}>
					<header className="plan-flow-head">
						<DialogTitle>{title}</DialogTitle>
						{input.summary && <DialogDescription>{input.summary}</DialogDescription>}
					</header>
					<div className="plan-flow-body">
						<FlowCanvas lanes={lanes} selected={flow} select={setFlow} />
						<Inspector lanes={lanes} selected={flow} project={project} open={open} started={started.length > 0} />
					</div>
					{children && <footer className="plan-flow-decide">{children}</footer>}
				</DialogContent>
			</Dialog>
		</section>
	);
}

// blueprintLabel says in a few words what a task's blueprint runs after the agent's work.
function blueprintLabel(b: PlanBlueprint | undefined) {
	if (!b || typeof b === 'string') return '';
	if (b.manual) return "Mob's model checks";
	const has = (type: string) => b.stages.some((s) => s.type === type);
	if (has('verify') && has('review')) return 'checks, then review';
	if (has('verify')) return 'checks only';
	if (has('review')) return 'review only';
	return 'no checks';
}

// steps lays out a task's lane, and where a started task is along it.
function steps(task: PlanTask, b: PlanBlueprint | undefined, project: string, node: AgentNode | undefined): Step[] {
	const agent = node?.label || task.agent || 'The agent';
	const list: Step[] = [
		{
			kind: 'build',
			label: kindLabels.build,
			title: agent,
			sub: task.title ?? '',
			does: `${agent} works on “${task.title}” in its own worktree and branch${project ? ` of ${project}` : ''}.`,
			state: 'idle',
		},
	];
	if (b && typeof b === 'object' && b.manual)
		list.push({
			kind: 'model',
			label: kindLabels.model,
			title: "Mob's model",
			sub: 'Checks as it sees fit',
			does: `Once ${agent} is done, Mob's model looks at the work and decides what happens next.`,
			state: 'idle',
		});
	else if (b && typeof b === 'object')
		for (const stage of b.stages) {
			if (stage.type === 'verify')
				list.push({
					kind: 'verify',
					label: kindLabels.verify,
					title: "Project's checks",
					sub: `Up to ${plural(stage.retries, 'retry', 'retries')}`,
					does: `Mob runs the project's checks in the task's worktree. A failure goes back to ${agent} with the end of its output, up to ${plural(stage.retries, 'time')}; after that the task needs you.`,
					state: 'idle',
					stage,
				});
			else
				list.push({
					kind: 'review',
					label: kindLabels.review,
					title: 'Another agent reviews',
					sub: stage.aspects.join(', '),
					does: `An agent other than ${agent} reads the branch and reviews ${stage.aspects.join(' and ')}. Mob keeps the findings that hold up and sends them back to ${agent}, for up to ${plural(stage.rounds, 'round')}; after that the task needs you.`,
					state: 'idle',
					stage,
				});
		}
	list.push({
		kind: 'ready',
		label: kindLabels.ready,
		title: 'Ready to review',
		sub: 'You hear once',
		does:
			typeof b === 'string'
				? `The task follows its blueprint: ${b}.`
				: 'You get one notice with the branch, the checks, the review’s conclusion and the cost, and decide what happens next.',
		state: 'idle',
	});
	if (node) place(list, node);
	return list;
}

// place marks where started task node is: the steps behind it done, its own running, waiting or stuck.
function place(list: Step[], node: AgentNode) {
	const flow = node.task?.flow;
	const at = (kind: StepKind) => list.findIndex((s) => s.kind === kind);
	let current = 0;
	let state: State = 'run';
	let now = node.status === 'waiting' ? 'Waiting for you' : 'Working';
	if (node.status === 'failed' || node.status === 'stopped') {
		state = 'fail';
		now = node.status === 'failed' ? 'Failed' : 'Stopped';
	} else if (node.status === 'waiting') state = 'wait';
	if (flow && node.status === 'review') {
		if (flow.stage === 'verify') {
			current = at('verify');
			now = flow.tries ? `Checking again · try ${flow.tries + 1}` : 'Running the checks';
		} else if (flow.stage === 'review') {
			current = at('review');
			now = `Round ${flow.round}`;
		} else if (flow.stage === 'ready') {
			current = list.length - 1;
			state = 'done';
			now = 'Ready to review';
		} else if (flow.stage === 'stuck') {
			const failed = flow.checks?.some((c) => !c.passed);
			current = at(failed || at('review') < 0 ? 'verify' : 'review');
			state = 'wait';
			now = flow.note || 'Needs you';
		}
	} else if (flow?.stage === 'build' && (flow.tries || flow.round > 1))
		now = flow.tries ? 'Fixing what the checks found' : `Reworking · round ${flow.round}`;
	else if (!flow && node.status === 'review') {
		// Without a blueprint flow, a task under review is past its agent's work; Mob's model has it.
		current = Math.max(at('model'), 0);
		now = 'Done; Mob is looking';
	}
	if (current < 0) current = 0;
	list.forEach((s, i) => {
		if (i < current) s.state = 'done';
		else if (i === current) {
			s.state = state;
			s.now = now;
		}
	});
}

// The canvas's sizes: a node, the space between nodes, a lane, and the room the loops take under a lane.
const W = 176,
	H = 72,
	G = 44,
	planW = 140,
	youW = 140,
	shipW = 156,
	pad = 28,
	laneH = H + 78;

/** FlowCanvas draws the plan: the plan node, one lane per task, then you, then shipping, which is always yours. */
function FlowCanvas({ lanes, selected, select }: { lanes: Lane[]; selected?: string; select: (key: string) => void }) {
	const id = useId().replace(/:/g, '');
	const canvas = useRef<HTMLDivElement>(null);
	const [zoom, setZoom] = useState(1);
	const cols = Math.max(2, ...lanes.map((l) => l.steps.length));
	const laneX = pad + planW + 56;
	const colX = (j: number) => laneX + j * (W + G);
	const youX = colX(cols - 1) + W + 56;
	const shipX = youX + youW + G;
	const width = shipX + shipW + pad;
	// The last lane's loops and their labels hang under it.
	const height = pad * 2 + (lanes.length - 1) * laneH + H + 68;
	const laneY = (i: number) => pad + i * laneH;
	const mid = (laneY(0) + laneY(lanes.length - 1) + H) / 2;
	const curve = (x1: number, y1: number, x2: number, y2: number) =>
		`M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;
	// Fit the flow to the canvas once, so a wide plan starts whole.
	useLayoutEffect(() => {
		const w = canvas.current?.clientWidth;
		if (w) setZoom(Math.max(0.7, Math.min(1, Math.floor((w / width) * 20) / 20)));
	}, [width]);
	const wires: ReactNode[] = [];
	const loops: ReactNode[] = [];
	const nodes: ReactNode[] = [];
	lanes.forEach((lane, i) => {
		const y = laneY(i);
		wires.push(<path key={`p${i}`} d={curve(pad + planW, mid, laneX, y + H / 2)} markerEnd={`url(#${id}-arrow)`} />);
		lane.steps.forEach((s, j) => {
			// Ready lines up across lanes, so you see every task's end in one column.
			const col = s.kind === 'ready' ? cols - 1 : j;
			const x = colX(col);
			if (j > 0) {
				const px = colX(j - 1) + W;
				wires.push(
					<path
						key={`w${i}.${j}`}
						d={`M${px} ${y + H / 2} H${x}`}
						markerEnd={`url(#${id}-arrow)`}
						data-state={s.state === 'idle' ? undefined : 'on'}
					/>,
				);
			}
			if (s.stage) {
				// A stage sends failures back to the agent: a loop under the lane, from the stage to the agent.
				const depth = s.kind === 'verify' ? 26 : 52;
				const from = x + W / 2;
				const to = colX(0) + W / 2;
				loops.push(
					<path
						key={`l${i}.${j}`}
						className="plan-loop"
						d={`M${from} ${y + H} V${y + H + depth - 10} Q${from} ${y + H + depth} ${from - 10} ${y + H + depth} H${to + 10} Q${to} ${y + H + depth} ${to} ${y + H + depth - 10} V${y + H + 4}`}
						markerEnd={`url(#${id}-arrow)`}
					/>,
				);
				nodes.push(
					<span key={`ll${i}.${j}`} className="plan-loop-label" style={{ left: (from + to) / 2, top: y + H + depth }}>
						{s.stage.type === 'verify' ? `fails → back · ≤ ${s.stage.retries}×` : `rework → back · ≤ ${plural(s.stage.rounds, 'round')}`}
					</span>,
				);
			}
			const key = `${i}.${s.kind}`;
			nodes.push(
				<button
					key={key}
					type="button"
					className="plan-node"
					data-kind={s.kind}
					data-state={s.state}
					aria-pressed={selected === key}
					style={{ left: x, top: y, width: W, height: H }}
					onClick={() => select(key)}
				>
					<span className="plan-node-head">
						<StepIcon kind={s.kind} />
						{s.label}
						{s.state !== 'idle' && <StateMark state={s.state} />}
					</span>
					<span className="plan-node-title">{s.title}</span>
					<span className="plan-node-sub">{s.now ?? s.sub}</span>
				</button>,
			);
		});
		wires.push(<path key={`y${i}`} d={curve(colX(cols - 1) + W, y + H / 2, youX, mid)} markerEnd={`url(#${id}-arrow)`} />);
	});
	wires.push(<path key="ship" className="plan-wire-locked" d={`M${youX + youW} ${mid} H${shipX}`} markerEnd={`url(#${id}-arrow)`} />);
	const fixed = (key: string, x: number, w: number, kind: string, label: string, title: string, sub: string, icon: ReactNode) => (
		<button
			key={key}
			type="button"
			className="plan-node"
			data-kind={kind}
			aria-pressed={selected === key}
			style={{ left: x, top: mid - H / 2, width: w, height: H }}
			onClick={() => select(key)}
		>
			<span className="plan-node-head">
				{icon}
				{label}
			</span>
			<span className="plan-node-title">{title}</span>
			<span className="plan-node-sub">{sub}</span>
		</button>
	);
	return (
		<div className="plan-canvas">
			<div className="plan-canvas-scroll" ref={canvas}>
				<div className="plan-canvas-size" style={{ width: width * zoom, height: height * zoom }}>
					<div className="plan-canvas-inner" style={{ width, height, transform: `scale(${zoom})` }}>
						<svg className="plan-wires" width={width} height={height} aria-hidden="true">
							<defs>
								<marker
									id={`${id}-arrow`}
									viewBox="0 0 10 10"
									refX="9"
									refY="5"
									markerWidth="7"
									markerHeight="7"
									orient="auto-start-reverse"
								>
									<path d="M0 1 L9 5 L0 9 z" />
								</marker>
							</defs>
							{wires}
							{loops}
						</svg>
						{fixed('plan', pad, planW, 'plan', 'Plan', plural(lanes.length, 'task'), 'Start at once', <FlowIcon />)}
						{nodes}
						{fixed('you', youX, youW, 'you', 'You', 'Review each task', 'One notice each', <UserIcon />)}
						{fixed('ship', shipX, shipW, 'ship', 'Ship', 'Push and merge', 'Always yours', <LockIcon />)}
					</div>
				</div>
			</div>
			<div className="plan-zoom" role="group" aria-label="Zoom">
				<button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}>
					−
				</button>
				<span>{Math.round(zoom * 100)}%</span>
				<button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(2)))}>
					+
				</button>
			</div>
		</div>
	);
}

/** Inspector says what the selected step does, and for a started task, where it is; the instructions and checks are a click further. */
function Inspector({
	lanes,
	selected,
	project,
	open,
	started,
}: {
	lanes: Lane[];
	selected?: string;
	project: string;
	open: (conversationId: string) => void;
	started: boolean;
}) {
	const [index, kind] = (selected ?? '').split('.');
	const lane = lanes[Number(index)];
	const step = lane?.steps.find((s) => s.kind === kind);
	if (selected === 'plan' || selected === 'you' || selected === 'ship' || !lane || !step) {
		const fixed: Record<string, [string, string, string]> = {
			plan: [
				'Plan',
				plural(lanes.length, 'task'),
				`${started ? 'These tasks started' : 'Approving starts these tasks'} at once${project ? ` in ${project}` : ''}, each for its agent in its own worktree and branch. The agents do not see each other's work.`,
			],
			you: [
				'You',
				'Review each task',
				'Each task tells you once, when it is ready or needs you. Nothing reaches the repository before you decide.',
			],
			ship: ['Ship', 'Push and merge', 'Mob does not push or merge. Each task’s work stays on its branch until you take it.'],
		};
		const [label, title, does] = fixed[selected ?? ''] ?? [
			'',
			'Select a step',
			'Each step says what it does, and once the plan starts, where its task is.',
		];
		return (
			<aside className="plan-inspector" aria-label="Step">
				{label && <p className="plan-inspector-kind">{label}</p>}
				<h3>{title}</h3>
				<section>
					<h4>What happens</h4>
					<p>{does}</p>
				</section>
				{selected === 'ship' && (
					<p className="plan-lock">
						<LockIcon /> Always asks you
					</p>
				)}
			</aside>
		);
	}
	const flow = lane.node?.task?.flow;
	return (
		<aside className="plan-inspector" aria-label="Step">
			<p className="plan-inspector-kind">
				{step.label} · task {Number(index) + 1}
			</p>
			<h3>{lane.task.title}</h3>
			{step.now && (
				<p className="plan-inspector-now" data-state={step.state}>
					<StateMark state={step.state} /> {step.now}
				</p>
			)}
			<section>
				<h4>What happens</h4>
				<p>{step.does}</p>
			</section>
			{step.kind === 'build' && lane.task.prompt && (
				<details className="plan-more">
					<summary>Instructions</summary>
					<p className="plan-prompt">{lane.task.prompt}</p>
				</details>
			)}
			{step.stage?.type === 'review' && (
				<section>
					<h4>Looks at</h4>
					<p className="plan-chips">
						{step.stage.aspects.map((a) => (
							<span key={a}>{a}</span>
						))}
					</p>
				</section>
			)}
			{step.kind === 'verify' && flow?.checks && flow.checks.length > 0 && (
				<details className="plan-more">
					<summary>Last checks</summary>
					<ul className="plan-checks">
						{flow.checks.map((c) => (
							<li key={c.command} data-passed={c.passed}>
								{c.passed ? <CheckIcon /> : <HandIcon />}
								<code>{c.command}</code>
							</li>
						))}
					</ul>
				</details>
			)}
			{step.kind === 'review' && flow?.review && (
				<details className="plan-more">
					<summary>Review’s conclusion</summary>
					<p className="plan-prompt">{flow.review}</p>
				</details>
			)}
			{lane.run && (
				<button type="button" className="plan-inspector-open" onClick={() => open(lane.run!.conversation)}>
					<OpenIcon /> Open its conversation
				</button>
			)}
		</aside>
	);
}

function StepIcon({ kind }: { kind: StepKind }) {
	if (kind === 'verify') return <TerminalIcon />;
	if (kind === 'review') return <EyeIcon />;
	if (kind === 'ready') return <CheckIcon />;
	if (kind === 'model') return <EyeIcon />;
	return <AgentIcon />;
}

function StateMark({ state }: { state: State }) {
	if (state === 'run') return <SpinnerIcon />;
	if (state === 'done') return <CheckIcon />;
	if (state === 'wait' || state === 'fail') return <HandIcon />;
	return null;
}

const FlowIcon = () => (
	<svg
		aria-hidden="true"
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect x="3" y="4" width="6" height="5" rx="1.5" />
		<rect x="15" y="4" width="6" height="5" rx="1.5" />
		<rect x="9" y="15" width="6" height="5" rx="1.5" />
		<path d="M9 6.5h6M18 9v3H12v3" />
	</svg>
);
const AgentIcon = () => (
	<svg
		aria-hidden="true"
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<path d="m8 9-3 3 3 3M16 9l3 3-3 3M13.5 6l-3 12" />
	</svg>
);
const LockIcon = () => (
	<svg
		aria-hidden="true"
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<rect x="5" y="11" width="14" height="9" rx="2" />
		<path d="M8 11V8a4 4 0 0 1 8 0v3" />
	</svg>
);

// useTasks reads the agent tree's nodes for the conversations listed, again whenever something changes.
function useTasks(connection: Connection, changes: Changes | undefined, conversations: string[]) {
	const [nodes, setNodes] = useState<AgentNode[]>([]);
	const key = conversations.join(' ');
	useEffect(() => {
		if (!key) return;
		let alive = true;
		const wanted = new Set(key.split(' '));
		const load = () =>
			api<AgentNode[]>(connection, '/tasks')
				.then((list) => alive && setNodes(list.filter((n) => wanted.has(n.conversationId))))
				.catch(() => {});
		void load();
		let soon: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = changes?.subscribe(() => {
			soon ??= setTimeout(() => {
				soon = undefined;
				void load();
			}, 1000);
		});
		const timer = setInterval(() => {
			if (!document.hidden && !changes?.live) void load();
		}, refreshEvery);
		return () => {
			alive = false;
			clearInterval(timer);
			clearTimeout(soon);
			unsubscribe?.();
		};
	}, [connection, changes, key]);
	return nodes;
}
