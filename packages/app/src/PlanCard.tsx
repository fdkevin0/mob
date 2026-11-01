import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Changes } from '@mob/client';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mob/ui/dialog';
import { Segmented } from '@mob/ui/segmented';
import { api, type Connection } from './api';
import type { AgentNode } from './contracts';
import { nodeStatus } from './AgentTree';
import { ApprovalPrompt } from './ApprovalPrompt';
import { PlanStudio, type StudioTask } from './PlanStudio';
import type { Place } from './planStudio';
import { CheckIcon, EyeIcon, HandIcon, OpenIcon, SpinnerIcon, TerminalIcon, UserIcon } from './icons';

/** Stage is a step a blueprint runs after the agent's work: the project's checks, or another agent's review. */
type Stage = { type: 'verify'; retries: number } | { type: 'review'; aspects: string[]; rounds: number };
/** PlanBlueprint is what a blueprint does; plans asked before the card drew them say it in a line only. */
type PlanBlueprint = string | { does: string; stages: Stage[]; manual?: boolean };

/** PlanInput is what task_plan asks the owner to approve: tasks in one project, and what each blueprint does. */
export type PlanInput = {
	project?: string;
	summary?: string;
	/** A task's stages are the owner's own for it, when they changed its blueprint's as they approved the plan. */
	tasks?: { title?: string; agent?: string; blueprint?: string; prompt?: string; stages?: Stage[] }[];
	blueprints?: Record<string, PlanBlueprint>;
};
/** PlanOutput is what an approved plan started; index is the task's place in the plan, missing from plans started before it was sent. */
type PlanOutput = { tasks?: { index?: number; task: string; conversation: string; title: string; agent: string; branch: string }[]; failed?: string[] };
type Run = NonNullable<PlanOutput['tasks']>[number];
type PlanTask = NonNullable<PlanInput['tasks']>[number];

// Started tasks change on their own; while changes are not live, the card reads them again this often.
const refreshEvery = 5000;

/** Step is a node of a task's lane: the agent builds, the blueprint's stages run, and the task is ready. */
type StepKind = 'build' | 'verify' | 'review' | 'model' | 'ready';
/** State is where a started task is at a step. */
type State = 'idle' | 'run' | 'wait' | 'done' | 'fail';
type Step = { kind: StepKind; label: string; title: string; sub: string; does: string; state: State; now?: string; stage?: Stage; edited?: boolean };
/** Lane is a task as the card draws it; stages are what it runs after the agent's work, unset when the owner cannot change them. */
type Lane = { task: PlanTask; run?: Run; node?: AgentNode; steps: Step[]; stages?: Stage[] };
/** Change is what the owner changed in one task while the plan waits: its instructions, and the stages it runs. */
type Change = { prompt?: string; stages?: Stage[] };

// The aspects a review can look at, and the bounds of a blueprint's loops, as Mob checks them when the owner changes a plan.
const aspects = ['correctness', 'tests', 'hygiene', 'docs', 'security'];
const maxRetries = 3,
	maxRounds = 3;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
	approval,
	defaultFlow,
	defaultView = 'flow',
	children,
}: {
	connection: Connection;
	changes?: Changes;
	input: PlanInput;
	output?: unknown;
	/** state is the call's: its icon and label. */
	state: { kind: string; label: string; icon: ReactNode };
	open: (conversationId: string) => void;
	/** approval decides the plan while it waits for the owner, with what they changed in it as input. */
	approval?: { busy: boolean; decide: (approved: boolean, reason?: string, remember?: string, input?: unknown) => void };
	/** defaultFlow opens the flow on this step at first, such as "0.build" (the docs' prototypes do). */
	defaultFlow?: string;
	/** defaultView is how the open plan is drawn at first: as a flow, or as a studio of calves. */
	defaultView?: View;
	children?: ReactNode;
}) {
	const done = planOutput(output);
	const started = done.tasks ?? [];
	const nodes = useTasks(
		connection,
		changes,
		started.map((t) => t.conversation),
	);
	const [flow, setFlow] = useState<string | undefined>(defaultFlow);
	const [view, setView] = useState<View>(defaultView);
	// A flow open from the start leaves focus where it is, so the page around it does not scroll to it.
	const quiet = useRef(defaultFlow !== undefined);
	const [changed, setChanged] = useState<Change[]>([]);
	const tasks = input.tasks ?? [];
	const editable = !!approval;
	const project = (input.project ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
	// Each started task names its place in the plan. Older plans did not, and their tasks started in plan order, so each is the next of the plan's with its title and agent.
	let next = 0;
	const indexed = started.every((s) => s.index !== undefined);
	const lanes: Lane[] = tasks.map((task, i) => {
		const s = started[next];
		const run = indexed ? started.find((r) => r.index === i) : s && s.title === task.title && s.agent === task.agent ? started[next++] : undefined;
		const node = run && nodes.find((n) => n.conversationId === run.conversation);
		const b = input.blueprints?.[task.blueprint ?? ''];
		// Only a blueprint whose stages the card knows, and that Mob does not leave to its model, has stages to change.
		const asked = typeof b === 'object' && !b.manual ? (task.stages ?? b.stages) : undefined;
		const c = editable ? changed[i] : undefined;
		const stages = c?.stages ?? asked;
		const shown = { ...task, prompt: c?.prompt ?? task.prompt };
		const lane: Lane = { task: shown, run, node, steps: steps(shown, b, stages, project, node), stages: editable ? stages : undefined };
		for (const st of lane.steps) {
			if (st.kind === 'build') st.edited = c?.prompt !== undefined && c.prompt !== task.prompt;
			else if (st.stage) st.edited = c?.stages !== undefined && !same(st.stage, asked?.find((a) => a.type === st.stage!.type));
		}
		return lane;
	});
	// count is how many things the owner changed: each task's instructions, and each stage added, changed or removed.
	let count = 0;
	const payload = tasks.map((task, i) => {
		const c = editable ? changed[i] : undefined;
		const b = input.blueprints?.[task.blueprint ?? ''];
		const asked = typeof b === 'object' && !b.manual ? (task.stages ?? b.stages) : undefined;
		const out: Change = {};
		if (c?.prompt !== undefined && c.prompt !== task.prompt) {
			out.prompt = c.prompt;
			count++;
		}
		if (c?.stages && !same(c.stages, asked)) {
			out.stages = c.stages;
			for (const type of ['verify', 'review']) if (!same(c.stages.find((s) => s.type === type), asked?.find((s) => s.type === type))) count++;
		}
		return out;
	});
	const change = (i: number, c: Change) => setChanged((all) => Object.assign([...all], { [i]: { ...all[i], ...c } }));
	const decide = approval && (
		<div className="plan-decide">
			{count > 0 && (
				<p className="plan-changes">
					<span>{plural(count, 'change')}</span>
					<button type="button" onClick={() => setChanged([])}>
						Undo changes
					</button>
				</p>
			)}
			<ApprovalPrompt
				question={`Mob wants to start ${tasks.length === 1 ? 'this task' : 'these tasks'} at once.`}
				busy={approval.busy}
				allow={count ? `Approve with ${plural(count, 'change')}` : 'Allow once'}
				decide={(approved, reason, remember) => approval.decide(approved, reason, remember, approved && count ? { tasks: payload } : undefined)}
			/>
		</div>
	);
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
										{[lane.task.agent, blueprintLabel(input.blueprints?.[lane.task.blueprint ?? ''], lane.steps), lane.run?.branch]
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
			{done.failed?.map((f) => (
				<p key={f} className="plan-failed" role="alert">
					Did not start: {f}
				</p>
			))}
			{decide}
			{children}
			<Dialog open={flow !== undefined} onOpenChange={(show) => !show && setFlow(undefined)}>
				<DialogContent
					className="plan-flow-dialog"
					aria-describedby={undefined}
					onOpenAutoFocus={(e) => {
						if (quiet.current) e.preventDefault();
						quiet.current = false;
					}}
				>
					<header className="plan-flow-head">
						<div>
							<DialogTitle>{title}</DialogTitle>
							{input.summary && <DialogDescription>{input.summary}</DialogDescription>}
						</div>
						<Segmented label="Draw the plan as" value={view} onChange={setView} options={views} className="plan-view" />
					</header>
					{view === 'studio' ? (
						<PlanStudio
							tasks={lanes.map(studioTask(editable))}
							waiting={editable}
							select={(i) => {
								setView('flow');
								setFlow(`${i}.build`);
							}}
						/>
					) : (
						<div className="plan-flow-body">
							<FlowCanvas lanes={lanes} selected={flow} select={setFlow} />
							<Inspector
								lanes={lanes}
								selected={flow}
								select={setFlow}
								project={project}
								open={open}
								started={started.length > 0}
								change={approval && !approval.busy ? change : undefined}
							/>
						</div>
					)}
					{decide && <footer className="plan-flow-decide">{decide}</footer>}
				</DialogContent>
			</Dialog>
		</section>
	);
}

type View = 'flow' | 'studio';
const views: { value: View; label: string }[] = [
	{ value: 'flow', label: 'Flow' },
	{ value: 'studio', label: 'Studio' },
];

// studioTask is a lane as the studio draws it: which stations its stages have, and where its task is.
const studioTask =
	(waiting: boolean) =>
	(lane: Lane): StudioTask => {
		const has = (kind: StepKind) => lane.steps.some((s) => s.kind === kind);
		const base = { title: lane.task.title ?? '', checks: has('verify'), review: has('review') };
		const node = lane.node;
		if (!node) return { ...base, status: waiting ? 'Waiting for your approval' : lane.run ? 'Started' : 'Not started', tone: waiting ? 'wait' : 'idle' };
		const status = nodeStatus(node).label;
		const flow = node.task?.flow;
		const stage = flow?.stage;
		if (node.status === 'review' && (stage === 'verify' || stage === 'review' || stage === 'ready' || stage === 'stuck')) {
			const place: Place = stage;
			return { ...base, place, status, tone: place === 'ready' ? 'ok' : place === 'stuck' ? 'wait' : 'run' };
		}
		if (node.status === 'running') {
			const fixing = !!flow && (flow.tries > 0 || flow.round > 1);
			return { ...base, place: 'build', fixing, status: flow ? (fixing ? 'Fixing what was found' : 'Building') : status, tone: fixing ? 'wait' : 'run' };
		}
		return { ...base, status, tone: 'idle' };
	};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
const stage = (v: unknown): v is Stage =>
	isObject(v) &&
	((v.type === 'verify' && Number.isInteger(v.retries)) || (v.type === 'review' && Array.isArray(v.aspects) && v.aspects.every((a) => typeof a === 'string') && Number.isInteger(v.rounds)));

/**
 * planInput reads a task_plan call's input as the card shows it, or undefined
 * when it is not a plan at all, such as a model's call Mob refused; the
 * conversation then shows the call as any other tool's.
 */
export function planInput(raw: unknown): PlanInput | undefined {
	// A call whose input is still streaming in has none yet.
	if (raw === undefined || raw === null) return {};
	if (!isObject(raw) || (raw.tasks !== undefined && (!Array.isArray(raw.tasks) || !raw.tasks.every(isObject)))) return undefined;
	const blueprints: Record<string, PlanBlueprint> = {};
	if (isObject(raw.blueprints))
		for (const [name, b] of Object.entries(raw.blueprints)) {
			if (typeof b === 'string') blueprints[name] = b;
			else if (isObject(b) && Array.isArray(b.stages) && b.stages.every(stage)) blueprints[name] = { does: text(b.does) ?? '', stages: b.stages, manual: b.manual === true };
		}
	return {
		project: text(raw.project),
		summary: text(raw.summary),
		tasks: (raw.tasks as Record<string, unknown>[] | undefined)?.map((t) => ({
			title: text(t.title),
			agent: text(t.agent),
			blueprint: text(t.blueprint),
			prompt: text(t.prompt),
			...(Array.isArray(t.stages) && t.stages.every(stage) ? { stages: t.stages } : {}),
		})),
		blueprints,
	};
}

// planOutput reads what an approved plan started, leaving out what is not a started task.
function planOutput(raw: unknown): PlanOutput {
	if (!isObject(raw)) return {};
	const tasks = Array.isArray(raw.tasks)
		? raw.tasks
				.filter((t): t is Record<string, unknown> => isObject(t) && typeof t.conversation === 'string')
				.map((t) => ({
					index: Number.isInteger(t.index) ? (t.index as number) : undefined,
					task: text(t.task) ?? '',
					conversation: t.conversation as string,
					title: text(t.title) ?? '',
					agent: text(t.agent) ?? '',
					branch: text(t.branch) ?? '',
				}))
		: undefined;
	const failed = Array.isArray(raw.failed) ? raw.failed.filter((f): f is string => typeof f === 'string') : undefined;
	return { tasks, failed };
}

// blueprintLabel says in a few words what a task's blueprint runs after the agent's work.
function blueprintLabel(b: PlanBlueprint | undefined, list: Step[]) {
	if (!b || typeof b === 'string') return '';
	if (b.manual) return "Mob's model checks";
	const has = (kind: string) => list.some((s) => s.kind === kind);
	if (has('verify') && has('review')) return 'checks, then review';
	if (has('verify')) return 'checks only';
	if (has('review')) return 'review only';
	return 'no checks';
}

// steps lays out a task's lane, and where a started task is along it.
function steps(task: PlanTask, b: PlanBlueprint | undefined, stages: Stage[] | undefined, project: string, node: AgentNode | undefined): Step[] {
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
	else
		for (const stage of stages ?? []) {
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
						{s.edited && <i className="plan-edited" title="Changed" />}
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
	select,
	project,
	open,
	started,
	change,
}: {
	lanes: Lane[];
	selected?: string;
	select: (key: string) => void;
	project: string;
	open: (conversationId: string) => void;
	started: boolean;
	/** change, set while the plan waits for the owner, changes a task's instructions or stages. */
	change?: (index: number, c: Change) => void;
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
	const i = Number(index);
	// setStage puts stage in place of the lane's stage of its type, or removes that stage when stage is undefined; checks run before a review.
	const setStage = (type: Stage['type'], next: Stage | undefined) => {
		const list = (lane.stages ?? []).filter((s) => s.type !== type);
		if (next) list.push(next);
		list.sort((a, b) => (a.type === b.type ? 0 : a.type === 'verify' ? -1 : 1));
		change?.(i, { stages: list });
	};
	const verify = step.stage?.type === 'verify' ? step.stage : undefined;
	const review = step.stage?.type === 'review' ? step.stage : undefined;
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
			{step.kind === 'build' && change && (
				<details className="plan-more" open={step.edited || undefined}>
					<summary>Instructions</summary>
					<textarea
						className="plan-field"
						aria-label="Instructions"
						value={lane.task.prompt ?? ''}
						rows={6}
						onChange={(e) => change(i, { prompt: e.target.value })}
					/>
				</details>
			)}
			{step.kind === 'build' && !change && lane.task.prompt && (
				<details className="plan-more">
					<summary>Instructions</summary>
					<p className="plan-prompt">{lane.task.prompt}</p>
				</details>
			)}
			{verify && change && (
				<section>
					<h4>When a check fails</h4>
					<Stepper
						label="Retries"
						value={verify.retries}
						min={0}
						max={maxRetries}
						unit={(n) => (n === 1 ? 'retry, then it needs you' : 'retries, then it needs you')}
						set={(n) => setStage('verify', { ...verify, retries: n })}
					/>
				</section>
			)}
			{review && (
				<section>
					<h4>Looks at</h4>
					<p className="plan-chips">
						{(change ? aspects : review.aspects).map((a) =>
							change ? (
								<button
									key={a}
									type="button"
									aria-pressed={review.aspects.includes(a)}
									// A review looks at one aspect or more.
									disabled={review.aspects.length === 1 && review.aspects.includes(a)}
									onClick={() =>
										setStage('review', {
											...review,
											aspects: review.aspects.includes(a) ? review.aspects.filter((x) => x !== a) : aspects.filter((x) => x === a || review.aspects.includes(x)),
										})
									}
								>
									{a}
								</button>
							) : (
								<span key={a}>{a}</span>
							),
						)}
					</p>
				</section>
			)}
			{review && change && (
				<section>
					<h4>Rework</h4>
					<Stepper
						label="Rounds"
						value={review.rounds}
						min={1}
						max={maxRounds}
						unit={(n) => (n === 1 ? 'round at most' : 'rounds at most')}
						set={(n) => setStage('review', { ...review, rounds: n })}
					/>
					<button
						type="button"
						className="plan-inspector-remove"
						onClick={() => {
							setStage('review', undefined);
							select(`${i}.ready`);
						}}
					>
						Remove this review
					</button>
				</section>
			)}
			{step.kind === 'ready' && change && lane.stages && !lane.stages.some((s) => s.type === 'review') && (
				<button
					type="button"
					className="plan-inspector-open"
					onClick={() => {
						setStage('review', { type: 'review', aspects: ['correctness', 'tests'], rounds: 1 });
						select(`${i}.review`);
					}}
				>
					+ Add a review before this
				</button>
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

// Stepper sets a small count, such as a stage's retries, within its bounds.
function Stepper({ label, value, min, max, unit, set }: { label: string; value: number; min: number; max: number; unit: (n: number) => string; set: (n: number) => void }) {
	return (
		<div className="plan-stepper" role="group" aria-label={label}>
			<span className="plan-stepper-box">
				<button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - 1)}>
					−
				</button>
				<output>{value}</output>
				<button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + 1)}>
					+
				</button>
			</span>
			<span>{unit(value)}</span>
		</div>
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
