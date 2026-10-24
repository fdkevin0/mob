// The tree of who started whom: tasks, and Mob's conversations that started them.
import { brief, describeApproval, outcomeBlocked, outcomePassed, outcomeRework, taskFailed, taskReview, taskRunning, taskStopped, taskWaiting, type Task, type UsageSummary } from '@mob/core';
import { preset } from './presets';
import type { Service } from './service';

/** mob is the agent of Mob's own conversations in the tree. */
export const mob = 'mob';
/** idle is the status of a Mob conversation that is not answering and waits for no decision. */
export const idle = 'idle';

/** AgentApproval is a decision waiting in an agent's conversation. */
export type AgentApproval = {
	id: string;
	tool: string;
	/** text is what is asked: one "field: value" line per input field, so that a command shows in full rather than only its title. */
	text: string;
	/** whole is false when a field was too long to show; the owner then decides in the conversation. */
	whole: boolean;
};

/** AgentNode is one conversation in the tree: a task, or a conversation of Mob's that started tasks. */
export type AgentNode = {
	conversationId: string;
	/** parent is the conversation that started this one; unset for a root. */
	parent?: string;
	/** agent is the task's agent, or mob; label is its display name. */
	agent: string;
	label: string;
	/** model is the model the agent runs: the one its running session's options select, else the one that used the most tokens. */
	model?: string;
	title: string;
	/** status is a task status, or running, waiting or idle for Mob. */
	status: string;
	/** approvals are the decisions that wait for the owner, oldest first. */
	approvals: AgentApproval[];
	/** tools are the kinds of tool the agent used, such as execute or edit. */
	tools: string[];
	task?: Task;
	usage?: UsageSummary;
};

/** waiting lists the decisions that wait in conversationID. */
function waiting(svc: Service, conversationID: string): AgentApproval[] {
	return svc.conversations.pending(conversationID).map(p => {
		const [text, whole] = describeApproval(p.tool, p.input);
		// The card names the tool itself.
		const i = text.indexOf('\n');
		return { id: p.id, tool: p.tool, text: i < 0 ? '' : text.slice(i + 1), whole };
	});
}

/** tree lists the tasks, most recently updated first, then the conversations that started them and are no task. */
export function tree(svc: Service, project: string): AgentNode[] {
	const tasks = svc.store.tasks(project);
	const isTask = new Set(tasks.map(t => t.conversationId));
	const parents = new Set<string>();
	const nodes: AgentNode[] = tasks.map(t => {
		let label = t.agent;
		try { label = preset(t.agent).title; } catch { /* an agent Mob no longer knows */ }
		const tools = svc.store.toolsUsed(t.conversationId).filter(n => n.startsWith(t.agent + '_')).map(n => n.slice(t.agent.length + 1));
		if (t.parent && !isTask.has(t.parent)) parents.add(t.parent);
		const n: AgentNode = { conversationId: t.conversationId, agent: t.agent, label, title: t.title, status: t.status, approvals: waiting(svc, t.conversationId), tools, task: t };
		if (t.parent) n.parent = t.parent;
		const model = svc.sessionModel(t.id);
		if (model) n.model = model;
		return n;
	});
	if (parents.size) {
		for (const c of svc.store.list()) {
			if (!parents.has(c.id)) continue;
			const n: AgentNode = { conversationId: c.id, agent: mob, label: 'Mob', title: c.title, status: idle, approvals: waiting(svc, c.id), tools: [] };
			if (n.approvals.length) n.status = taskWaiting;
			else if (svc.conversations.isActive(c.id)) n.status = taskRunning;
			nodes.push(n);
		}
	}
	const used = svc.store.conversationUsage(...nodes.map(n => n.conversationId));
	for (const n of nodes) {
		const u = used.get(n.conversationId);
		if (!u) continue;
		n.usage = u;
		// An agent that names no model is recorded under its own name.
		if (!n.model && u.models.length && u.models[0]!.model !== n.agent) n.model = u.models[0]!.model;
	}
	return nodes;
}

/** statusLabels are how /tasks names statuses. */
export const statusLabels: Record<string, string> = {
	[taskRunning]: 'Running', [taskWaiting]: 'Needs you', [taskReview]: 'Done', [taskStopped]: 'Stopped', [taskFailed]: 'Failed', [idle]: 'Idle',
};

/** outcomeLabels are how reports name outcomes. */
export const outcomeLabels: Record<string, string> = { [outcomePassed]: 'passed', [outcomeRework]: 'needs rework', [outcomeBlocked]: 'blocked' };

/** label is how a report names what task t is doing and, once it said, how its work ended. */
export const label = (t: Task) => t.outcome ? statusLabels[t.status] + ', ' + outcomeLabels[t.outcome] : statusLabels[t.status]!;

/** outline writes nodes as a Markdown list nested by who started whom. */
export function outline(nodes: AgentNode[]) {
	const known = new Set(nodes.map(n => n.conversationId));
	const children = new Map<string, AgentNode[]>();
	for (const n of nodes) {
		const parent = n.parent && known.has(n.parent) ? n.parent : '';
		children.set(parent, [...children.get(parent) ?? [], n]);
	}
	let b = '';
	const write = (parent: string, depth: number) => {
		for (const n of children.get(parent) ?? []) {
			const status = n.task ? label(n.task) : statusLabels[n.status];
			b += `${'  '.repeat(depth)}- **${status}** · ${n.label} · ${n.title}`;
			if (n.task) b += ` · ${n.task.project} \`${n.task.branch}\``;
			if (n.usage) b += ' · ' + brief(n.usage);
			b += '\n';
			write(n.conversationId, depth + 1);
		}
	};
	write('', 0);
	return b;
}
