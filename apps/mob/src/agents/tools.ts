// What Mob's model and the owner use to manage tasks: tools and commands.
import { CommandError, cell, interactive, type Command, type Task, type Tool } from '@mob/core';
import { isAbsolute } from 'node:path';
import { firstLine, git } from './process';
import { preset, presets, readers } from './presets';
import { reviewTools } from './review';
import type { Service } from './service';
import { outline } from './tree';

/** managerPrompt makes Mob's own model the owner's project manager. */
const managerPrompt = "You are also the owner's project manager. Hand coding work in a project (changes, fixes, investigations, reviews) to a coding agent with task_start instead of doing it yourself; each task works on its own branch. Use tasks to report progress and what waits for the owner's decision, task_message to pass on instructions, and task_stop to stop a task. Before telling the owner a task is done, check its work: task_diff shows what it changed, and task_check runs the tests or build in its worktree.";

/** replyLimit bounds the latest reply tasks shows for each task, in characters. */
const replyLimit = 600;

export const object = (properties: Record<string, unknown>, ...required: string[]) =>
	({ type: 'object', properties, additionalProperties: false, ...required.length ? { required } : {} });
export const text = (description: string) => ({ type: 'string', description });

type StartInput = { project?: string; prompt?: string; title?: string; agent?: string; share?: string };

/** tools let Mob's model start, follow, instruct and stop tasks. */
export function tools(svc: Service): Tool[] {
	const agents = presets.map(p => p.name);
	return [{
		name: 'task_start',
		description: "Ask the owner to approve handing coding work to a coding agent. The agent works in a new git worktree and branch of the project; the turn stops until the owner approves.",
		parameters: object({
			project: text("A project's name, or the absolute path of a git repository on this computer"),
			prompt: text('What the agent should do, with everything it needs to know'),
			title: text('A short title for the task'),
			agent: { type: 'string', enum: agents, description: 'The coding agent; default ' + agents[0] },
			share: text(`A task's ID: work read-only in that task's worktree and branch instead of a new one, seeing its uncommitted changes, such as to review it; project is then that task's. Only ${readers().join(' and ')} can`),
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
			} else t = await svc.startTask(call.conversationId, input.project, input.agent, input.title, input.prompt);
			return { task: t.id, conversation: t.conversationId, branch: t.branch, worktree: t.worktree, status: 'started; the agent works on its own and its conversation shows its progress' };
		},
		scope: raw => {
			const v = JSON.parse(raw) as StartInput;
			// Reading a task's worktree is approved task by task.
			return v.share ? `${v.project ?? ''} ${v.agent ?? ''} read-only ${v.share}` : `${v.project ?? ''} ${v.agent ?? ''}`;
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
	}, ...reviewTools(svc)];
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
	const project = input.project ?? '';
	let path = svc.project(project)?.path;
	if (!path) {
		if (!isAbsolute(project)) throw new Error(`no project is called ${JSON.stringify(project)}; saved projects: ${svc.projects().map(p => p.name).join(', ')}. Give the absolute path of a git repository instead`);
		try { await git(project, 'rev-parse', '--show-toplevel'); } catch (e) { throw new Error(`${project} is not a git repository: ${(e as Error).message}`); }
		path = project;
	}
	return ask({ project: path, agent: a.name, title, prompt });
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
		const u = used.get(t.conversationId);
		if (u) entry.usage = u;
		return entry;
	});
	return { projects: svc.projects(), tasks };
}

/** commands list and save projects and list tasks. */
export function commands(svc: Service): Command[] {
	const usage = '/projects [add PATH [NAME] | remove NAME]';
	return [{
		name: 'projects', usage, summary: 'Show the projects coding agents work on, or add or remove one', clients: interactive, ownerOnly: true,
		run: async ({ fields: f }) => {
			if (!f.length) {
				const list = svc.projects();
				if (!list.length) return { markdown: 'No projects yet. Add a git repository with `/projects add PATH`.' };
				return { markdown: '| Project | Path |\n| --- | --- |\n' + list.map(p => `| ${cell(p.name)} | \`${p.path}\` |\n`).join('') };
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
			} catch (e) { throw new CommandError(400, (e as Error).message); }
			throw new CommandError(400, 'usage: ' + usage);
		},
	}, {
		name: 'tasks', usage: '/tasks [PROJECT]', summary: 'Show coding agent tasks and what they are doing', clients: interactive, ownerOnly: true,
		run: async ({ fields }) => {
			const nodes = svc.tree(fields[0] ?? '');
			return { markdown: nodes.length ? outline(nodes) : 'No tasks yet. Ask Mob to hand coding work in a project to a coding agent.' };
		},
	}];
}
