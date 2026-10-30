// What Mob's model and the owner use to manage tasks: tools and commands.
import { CommandError, cell, interactive, type Command, type Task, type Tool } from '@mob/core';
import { isAbsolute } from 'node:path';
import { blueprint, blueprints, defaultBlueprint, steps, type Stage } from './blueprints';
import { firstLine, git } from './process';
import { preset, presets, readers } from './presets';
import { reviewTools } from './review';
import { squadTool } from './squad';
import type { Service } from './service';
import { outline } from './tree';

/** managerPrompt makes Mob's own model the owner's project manager. */
const managerPrompt = `You are also the owner's project manager. Hand coding work in a host project (changes, fixes, investigations, reviews) to a coding agent with task_start; use the sandbox for unrelated isolated calculations and skill scripts. When the work splits into parts that can go on at once, propose them together with task_plan, so the owner approves the plan once instead of each task; give each task its own self-contained brief.
The coding agent does not automatically receive this conversation. Give it a self-contained brief: goal and project, scope and user constraints, relevant evidence and decisions, and acceptance checks. Preserve earlier constraints such as no new dependencies, API compatibility and analysis-only work unless the user changed them. Separate known facts from hypotheses; do not invent missing requirements. Tell it to read applicable project instructions, including AGENTS.md, before working and to report changes, verification and unfinished work. For analysis or review, explicitly require no file changes. Pass later corrections to the existing task with task_message rather than starting duplicate work.
Use tasks to report progress and what waits for the owner's decision, task_message to pass on instructions, and task_stop to stop a task. Each task you start follows a blueprint: once its agent is done, Mob itself runs the project's checks, has another agent review the work, sends what fails back to the agent, and tells the owner when it is ready, so do not check or review it again unless the owner asks. A task of the manual blueprint is yours to check when Mob asks: task_diff shows what it changed, and task_check runs the tests or build in its worktree.`;

/** replyLimit bounds the latest reply tasks shows for each task, in characters. */
const replyLimit = 600;

export const object = (properties: Record<string, unknown>, ...required: string[]) =>
	({ type: 'object', properties, additionalProperties: false, ...required.length ? { required } : {} });
export const text = (description: string) => ({ type: 'string', description });

type StartInput = { project?: string; prompt?: string; title?: string; agent?: string; share?: string; blueprint?: string };

/** PlanTask is one task of a plan, as the owner approves it. */
type PlanTask = { title: string; agent: string; blueprint: string; prompt: string };
/** PlanBlueprint is what a plan's blueprint does: in a line for people, and its stages for the card that draws it. */
type PlanBlueprint = { does: string; stages: Stage[]; manual?: true };
/** Plan is what task_plan asks the owner to approve: tasks in one project, and what each of their blueprints does. */
type Plan = { project: string; summary?: string; tasks: PlanTask[]; blueprints: Record<string, PlanBlueprint> };

/** planLimit bounds the tasks one plan starts. */
export const planLimit = 6;

/** tools let Mob's model start, follow, instruct and stop tasks. */
export function tools(svc: Service): Tool[] {
	const agents = presets.map(p => p.name);
	return [{
		name: 'task_start',
		description: "Ask the owner to approve handing coding work to a coding agent. The agent works in a new git worktree and branch of the project; the turn stops until the owner approves.",
		parameters: object({
			project: text("A project's name, or the absolute path of a git repository on this computer"),
			prompt: text('Self-contained task brief: goal, scope and user constraints, known evidence and decisions, acceptance checks, and a reminder to read applicable project instructions. The agent does not receive the parent conversation.'),
			title: text('A short title for the task'),
			agent: { type: 'string', enum: agents, description: 'The coding agent; default ' + agents[0] },
			share: text(`A task's ID: work read-only in that task's worktree and branch instead of a new one, seeing its uncommitted changes, such as to review it; project is then that task's. Only ${readers().join(' and ')} can`),
			blueprint: { type: 'string', enum: blueprints.map(b => b.name), description: "How the work goes from done to ready to review; default the project's blueprint. " + blueprints.map(b => `${b.name}: ${steps(b)}.`).join(' ') },
		}, 'prompt'),
		prompt: managerPrompt,
		ownerOnly: true,
		available: svc.offered,
		run: async call => askStart(svc, call.input as StartInput, input => call.requestApproval(input)),
		approved: async call => {
			const input = JSON.parse(call.input) as Required<StartInput>;
			let t: Task;
			if (input.share) {
				const base = svc.store.task(input.share);
				if (!base) throw new Error(`no task ${input.share}`);
				t = await svc.startReader(call.conversationId, base, input.agent, input.title, input.prompt);
			} else t = await svc.startTask(call.conversationId, input.project, input.agent, input.title, input.prompt, input.blueprint);
			return { task: t.id, conversation: t.conversationId, branch: t.branch, worktree: t.worktree, status: 'started; the agent works on its own and its conversation shows its progress' };
		},
		scope: raw => {
			const v = JSON.parse(raw) as StartInput;
			// Reading a task's worktree is approved task by task.
			return v.share ? `${v.project ?? ''} ${v.agent ?? ''} read-only ${v.share}` : `${v.project ?? ''} ${v.agent ?? ''} ${v.blueprint ?? ''}`.trimEnd();
		},
	}, {
		name: 'task_plan',
		description: `Ask the owner to approve a plan: up to ${planLimit} coding tasks in one project, each for a coding agent in its own worktree and branch, all started at once when the owner approves. Use it instead of several task_start calls when the work splits into parts that can go on at the same time; give each task everything it needs, since the agents do not see each other's work. The turn stops until the owner decides.`,
		parameters: object({
			project: text("A project's name, or the absolute path of a git repository on this computer"),
			summary: text('What the plan achieves, in a sentence'),
			tasks: {
				type: 'array', minItems: 1, maxItems: planLimit, description: 'The tasks, in the order to start them',
				items: object({
					title: text('A short title for the task'),
					prompt: text('What the agent should do, with everything it needs to know'),
					agent: { type: 'string', enum: agents, description: 'The coding agent; default ' + agents[0] },
					blueprint: { type: 'string', enum: blueprints.map(b => b.name), description: "How the work goes from done to ready to review; default the project's blueprint" },
				}, 'title', 'prompt'),
			},
		}, 'project', 'tasks'),
		ownerOnly: true,
		available: svc.offered,
		run: async call => call.requestApproval(await askPlan(svc, call.input as { project?: string; summary?: string; tasks?: StartInput[] })),
		approved: async call => {
			const plan = JSON.parse(call.input) as Plan;
			const started: { task: string; conversation: string; title: string; agent: string; branch: string }[] = [];
			const failed: string[] = [];
			for (const p of plan.tasks) {
				try {
					const t = await svc.startTask(call.conversationId, plan.project, p.agent, p.title, p.prompt, p.blueprint);
					started.push({ task: t.id, conversation: t.conversationId, title: t.title, agent: t.agent, branch: t.branch });
				} catch (e) { failed.push(`${p.title}: ${(e as Error).message}`); }
			}
			if (!started.length) throw new Error('no task started: ' + failed.join('; '));
			return { tasks: started, ...failed.length ? { failed } : {}, status: 'started; each agent works on its own, and Mob tells the owner as each task is ready' };
		},
		// Remembering covers plans in the same project with the same agents and blueprints.
		scope: raw => {
			const v = JSON.parse(raw) as Plan;
			return `${v.project} plan ${[...new Set(v.tasks.map(t => `${t.agent}/${t.blueprint}`))].sort().join(' ')}`;
		},
	}, {
		name: 'tasks',
		description: "List coding agent tasks with their status (running, waiting for the owner's approval, review, stopped, failed), branch, plan, latest reply, how the agent said its work ended (outcome passed, rework or blocked, with its result) and the tokens, cache and cost their agent used by model, and the saved projects.",
		parameters: object({ project: text("Only this project's tasks") }),
		ownerOnly: true,
		available: svc.busy,
		run: async call => overview(svc, String(call.input.project ?? '')),
	}, {
		name: 'task_message',
		description: "Pass the owner's instructions on to a task's coding agent; it works on them on its own.",
		parameters: object({ task: text("The task's ID"), text: text('The instructions') }, 'task', 'text'),
		ownerOnly: true,
		available: svc.busy,
		run: async call => {
			const message = String(call.input.text ?? '');
			if (!message.trim()) throw new Error('text is empty');
			await svc.message(String(call.input.task ?? ''), message);
			return { sent: true };
		},
	}, {
		name: 'task_stop',
		description: "Stop a task's coding agent. Its branch and worktree stay.",
		parameters: object({ task: text("The task's ID") }, 'task'),
		ownerOnly: true,
		available: svc.busy,
		run: async call => { svc.stopTask(String(call.input.task ?? '')); return { stopped: true }; },
	}, ...reviewTools(svc), squadTool(svc)];
}

/** askStart checks a task_start call and asks the owner to approve it. */
export async function askStart(svc: Service, input: StartInput, ask: (input: unknown) => Promise<never>): Promise<never> {
	const prompt = input.prompt ?? '';
	if (!prompt.trim()) throw new Error('prompt is empty');
	let agent = input.agent ?? '';
	if (input.share && !agent) agent = readers()[0]!;
	const a = preset(agent);
	const title = (input.title ?? '').trim() || firstLine(prompt, 60);
	if (input.share) {
		const base = svc.store.task(input.share);
		if (!base || base.id !== input.share) throw new Error(`no task ${input.share}`);
		if (base.readOnly) throw new Error("that task only reads another's worktree; share that one instead");
		if (!a.readOnly) throw new Error(`${a.title} cannot work read-only; use ${readers().join(' or ')}`);
		return ask({ project: base.project, agent: a.name, title, prompt, share: base.id, workspace: 'read-only in ' + base.worktree });
	}
	const { path, saved } = await projectOf(svc, input.project ?? '');
	const b = blueprint(input.blueprint || saved?.blueprint || '');
	return ask({ project: path, agent: a.name, title, prompt, blueprint: b.name, steps: steps(b) });
}

/** projectOf finds the saved project called project, or checks that project is the absolute path of a git repository. */
async function projectOf(svc: Service, project: string) {
	const saved = svc.project(project);
	if (saved) return { path: saved.path, saved };
	if (!isAbsolute(project)) throw new Error(`no project is called ${JSON.stringify(project)}; saved projects: ${svc.projects().map(p => p.name).join(', ')}. Give the absolute path of a git repository instead`);
	try { await git(project, 'rev-parse', '--show-toplevel'); } catch (e) { throw new Error(`${project} is not a git repository: ${(e as Error).message}`); }
	return { path: project, saved };
}

/** askPlan checks a task_plan call and returns the plan the owner is asked to approve. */
export async function askPlan(svc: Service, input: { project?: string; summary?: string; tasks?: StartInput[] }): Promise<Plan> {
	const list = Array.isArray(input.tasks) ? input.tasks : [];
	if (!list.length) throw new Error('a plan has one task or more');
	if (list.length > planLimit) throw new Error(`a plan has at most ${planLimit} tasks; start the rest once these are done`);
	const { path, saved } = await projectOf(svc, input.project ?? '');
	const tasks = list.map((t, i) => {
		const prompt = String(t.prompt ?? '');
		if (!prompt.trim()) throw new Error(`task ${i + 1}'s prompt is empty`);
		return { title: String(t.title ?? '').trim() || firstLine(prompt, 60), agent: preset(t.agent ?? '').name, blueprint: blueprint(t.blueprint || saved?.blueprint || '').name, prompt };
	});
	const summary = String(input.summary ?? '').trim();
	return { project: path, ...summary ? { summary } : {}, tasks, blueprints: Object.fromEntries([...new Set(tasks.map(t => t.blueprint))].map(n => {
		const b = blueprint(n);
		return [n, { does: steps(b), stages: b.stages, ...b.manual ? { manual: true as const } : {} }];
	})) };
}

/** overview is what tasks returns. */
export function overview(svc: Service, project: string) {
	const list = svc.store.tasks(project);
	const used = svc.store.conversationUsage(...list.map(t => t.conversationId));
	const tasks = list.map(t => {
		let reply = svc.store.lastReply(t.conversationId);
		const chars = [...reply];
		if (chars.length > replyLimit) reply = '…' + chars.slice(-replyLimit).join('');
		const entry: Record<string, unknown> = { id: t.id, project: t.project, agent: t.agent, title: t.title, status: t.status, branch: t.branch, worktree: t.worktree, conversation: t.conversationId };
		if (reply) entry.latestReply = reply;
		if (t.outcome) { entry.outcome = t.outcome; entry.result = t.result; }
		if (t.plan?.length) entry.plan = t.plan;
		if (t.flow) entry.blueprint = t.flow;
		const u = used.get(t.conversationId);
		if (u) entry.usage = u;
		return entry;
	});
	return { projects: svc.projects(), tasks };
}

/** commands list and save projects and list tasks. */
export function commands(svc: Service): Command[] {
	const usage = '/projects [add PATH [NAME] | remove NAME | blueprint NAME BLUEPRINT | check NAME COMMAND | checks NAME [clear]]';
	return [{
		name: 'projects', usage, summary: "Show the projects coding agents work on, add or remove one, or set its blueprint and checks", clients: interactive, ownerOnly: true,
		run: async ({ fields: f, rest }) => {
			if (!f.length) {
				const list = svc.projects();
				if (!list.length) return { markdown: 'No projects yet. Add a git repository with `/projects add PATH`.' };
				return { markdown: '| Project | Path | Blueprint | Checks |\n| --- | --- | --- | --- |\n' + list.map(p => `| ${cell(p.name)} | \`${p.path}\` | ${p.blueprint || defaultBlueprint} | ${p.checks?.map(c => '`' + cell(c) + '`').join('<br>') || 'none'} |\n`).join('') };
			}
			try {
				if (f[0] === 'add' && (f.length === 2 || f.length === 3)) {
					const p = await svc.addProject(f[1]!, f[2] ?? '');
					return { markdown: `Project ${p.name} is ${p.path}.` };
				}
				if (f[0] === 'remove' && f.length === 2) {
					svc.removeProject(f[1]!);
					return { markdown: 'Removed project ' + f[1] + '; its tasks and branches stay.' };
				}
				if (f[0] === 'blueprint' && f.length === 3) {
					const p = svc.setProject(f[1]!, { blueprint: f[2] === defaultBlueprint ? '' : f[2]! });
					const b = blueprint(p.blueprint ?? '');
					return { markdown: `New tasks in ${p.name} follow the ${b.title} blueprint: ${steps(b)}.` };
				}
				// A check is set only here, by the owner: Mob runs it without asking, so a model must not be able to choose it.
				if (f[0] === 'check' && f.length >= 3) {
					const command = rest.replace(/^check\s+\S+\s+/, '').trim();
					const p = svc.project(f[1]!);
					if (!p || p.name !== f[1]) throw new Error(`no project is called ${f[1]}`);
					const checks = [...p.checks ?? [], command];
					svc.setProject(p.name, { checks });
					return { markdown: `Mob runs ${checks.length === 1 ? 'this check' : 'these checks'} on ${p.name}'s finished tasks, in order:\n\n${checks.map(c => '- `' + c + '`').join('\n')}` };
				}
				if (f[0] === 'checks' && (f.length === 2 || (f.length === 3 && f[2] === 'clear'))) {
					const p = f.length === 3 ? svc.setProject(f[1]!, { checks: [] }) : svc.project(f[1]!);
					if (!p || p.name !== f[1]) throw new Error(`no project is called ${f[1]}`);
					return { markdown: p.checks?.length ? `Checks of ${p.name}, run in order:\n\n${p.checks.map(c => '- `' + c + '`').join('\n')}` : `${p.name} has no checks; add one with \`/projects check ${p.name} COMMAND\`.` };
				}
			} catch (e) { throw new CommandError(400, (e as Error).message); }
			throw new CommandError(400, 'usage: ' + usage);
		},
	}, {
		name: 'blueprints', usage: '/blueprints', summary: "Show the blueprints tasks follow from done to ready to review", clients: interactive, ownerOnly: true,
		run: async () => ({ markdown: blueprints.map(b => `- **${b.title}** (\`${b.name}\`${b.name === defaultBlueprint ? ', the default' : ''}): ${steps(b)}.`).join('\n') + '\n\nSet a project\'s with `/projects blueprint NAME BLUEPRINT`.' }),
	}, {
		name: 'tasks', usage: '/tasks [PROJECT]', summary: 'Show coding agent tasks and what they are doing', clients: [...interactive, 'telegram'], ownerOnly: true,
		run: async ({ fields }) => {
			const nodes = svc.tree(fields[0] ?? '');
			return { markdown: nodes.length ? outline(nodes) : 'No tasks yet. Ask Mob to hand coding work in a project to a coding agent.' };
		},
	}];
}
