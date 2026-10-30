import { useEffect, useState, type ReactNode } from 'react';
import type { Changes } from '@mob/client';
import { api, type Connection } from './api';
import type { AgentNode } from './contracts';
import { nodeStatus } from './AgentTree';
import { ChevronIcon } from './icons';

/** PlanInput is what task_plan asks the owner to approve: tasks in one project, and what each blueprint does. */
export type PlanInput = {
	project?: string;
	summary?: string;
	tasks?: { title?: string; agent?: string; blueprint?: string; prompt?: string }[];
	blueprints?: Record<string, string>;
};
/** PlanOutput is what an approved plan started. */
type PlanOutput = { tasks?: { task: string; conversation: string; title: string; agent: string; branch: string }[]; failed?: string[] };

// Started tasks change on their own; while changes are not live, the card reads them again this often.
const refreshEvery = 5000;

/**
 * PlanCard shows a plan Mob proposes: its tasks, each with its agent and
 * blueprint, and the decision while it waits for one. Once approved, each
 * task shows where it is, and opens its conversation.
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
	const nodes = useTasks(connection, changes, started.map((t) => t.conversation));
	const tasks = input.tasks ?? [];
	const project = (input.project ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
	// Tasks start in plan order, so each started task is the next of the plan's with its title and agent; one that failed to start is skipped.
	let next = 0;
	const runs = tasks.map((t) => {
		const s = started[next];
		if (s && s.title === t.title && s.agent === t.agent) {
			next++;
			return s;
		}
		return undefined;
	});
	return (
		<section className={`plan-card ${state.kind}`} aria-label="Plan">
			<header>
				<span className="tool-status" title={state.label}>
					{state.icon}
				</span>
				<strong>
					Plan · {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
					{project && ` in ${project}`}
				</strong>
				<span className="sr-only">{state.label}</span>
			</header>
			{input.summary && <p className="plan-summary">{input.summary}</p>}
			<ol className="plan-tasks">
				{tasks.map((t, i) => {
					const run = runs[i];
					const node = run && nodes.find((n) => n.conversationId === run.conversation);
					const status = node && nodeStatus(node);
					return (
						<li key={i} data-status={node?.status} data-stage={status?.stage}>
							<div className="plan-task-head">
								<span className="plan-task-title">{t.title}</span>
								{status ? (
									<button type="button" className="plan-task-status" onClick={() => open(run!.conversation)} title="Open its conversation">
										{status.icon}
										{status.label}
									</button>
								) : (
									run && (
										<button type="button" className="plan-task-status" onClick={() => open(run.conversation)} title="Open its conversation">
											Started
										</button>
									)
								)}
							</div>
							<p className="plan-task-meta">
								{[t.agent, t.blueprint && `${t.blueprint} blueprint`, run?.branch].filter(Boolean).join(' · ')}
							</p>
							{t.prompt && (
								<details className="plan-task-prompt">
									<summary>
										<ChevronIcon /> Instructions
									</summary>
									<p>{t.prompt}</p>
								</details>
							)}
						</li>
					);
				})}
			</ol>
			{children && input.blueprints && Object.keys(input.blueprints).length > 0 && (
				<ul className="plan-blueprints">
					{Object.entries(input.blueprints).map(([name, does]) => (
						<li key={name}>
							<strong>{name}</strong>: {does}
						</li>
					))}
				</ul>
			)}
			{(output as PlanOutput | undefined)?.failed?.map((f) => (
				<p key={f} className="plan-failed" role="alert">
					Did not start: {f}
				</p>
			))}
			{children}
		</section>
	);
}

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
