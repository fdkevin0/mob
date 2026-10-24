// Mob's MCP server on loopback, through which the agents report how their
// work ended and the agents of tasks Mob's conversations started hand parts of
// their work to sub-tasks; and the summaries that tell whoever started tasks
// that they all ended.
import type { McpServer as ACPMcpServer } from '@agentclientprotocol/sdk';
import { brief, newID, outcomeBlocked, outcomePassed, outcomeRework, taskReview, taskRunning, taskWaiting, CommandError, type Task } from '@mob/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { version } from '../version';
import { firstLine } from './process';
import { preset, readers } from './presets';
import type { Service } from './service';
import { label } from './tree';

/** subtaskActive bounds the sub-tasks of one task that run or wait at once. */
export const subtaskActive = 3;
/** subtaskTotal bounds the sub-tasks one task may start. */
export const subtaskTotal = 10;
/** mcpName is what the agents call Mob's MCP server. */
const mcpName = 'mob';
/** resultLimit bounds the summary an agent reports with its outcome, in characters. */
const resultLimit = 4000;
/** reportReply bounds the agent's words a summary repeats per task, in characters. */
const reportReply = 600;
/** tellTries bounds how often tell finds the parent's conversation busy. */
const tellTries = 5;

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** answer runs work as a tool's result: its text, or its error. */
async function answer(work: () => string | Promise<string>): Promise<Result> {
	try { return { content: [{ type: 'text', text: await work() }] }; } catch (e) {
		return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
	}
}

/** Hub is the MCP server. Each session has its own token, which names its task. */
export class Hub {
	private server?: ReturnType<typeof Bun.serve>;
	/** tokens are the tasks of the sessions that may use it, by token. */
	readonly tokens = new Map<string, string>();
	/** starting counts the sub-tasks being started, by the ID of the task starting them. */
	private starting = new Map<string, number>();
	/** settled is the ended tasks last reported to the conversation that started them, by its ID. */
	readonly settled = new Map<string, string>();

	constructor(private svc: Service) {}

	/**
	 * servers are the MCP servers a session of task t gets: Mob's, when the
	 * agent takes MCP servers over HTTP, through which it reports how its work
	 * ended and, if it may, starts sub-tasks.
	 */
	servers(t: Task, http: boolean): { servers: ACPMcpServer[]; token: string } {
		if (!http) return { servers: [], token: '' };
		let url: string;
		try { url = this.listen(); } catch (e) {
			console.warn('start the MCP server for sub-tasks: ' + (e as Error).message);
			return { servers: [], token: '' };
		}
		const token = newID() + newID();
		this.tokens.set(token, t.id);
		return { servers: [{ type: 'http', name: mcpName, url, headers: [{ name: 'Authorization', value: 'Bearer ' + token }] }], token };
	}

	/** forget stops token from reaching the MCP server. */
	forget(token: string) { if (token) this.tokens.delete(token); }

	/** listen starts the MCP server, unless it runs, and returns its URL. */
	listen(): string {
		if (this.svc.closed) throw new Error('Mob is stopping');
		this.server ??= Bun.serve({
			hostname: '127.0.0.1', port: 0,
			fetch: req => {
				if (new URL(req.url).pathname !== '/mcp') return new Response('not found', { status: 404 });
				const id = this.bearer(req);
				if (!id) return new Response('unauthorized', { status: 401 });
				// Stateless: every request is checked against the tokens as they are now, so a token forgotten when its session ends reaches nothing, and no MCP session outlives it.
				const server = this.serverFor(id);
				const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
				return server.connect(transport).then(() => transport.handleRequest(req));
			},
		});
		return `http://127.0.0.1:${this.server.port}/mcp`;
	}

	close() { void this.server?.stop(true); this.server = undefined; }

	/** bearer is the task whose token req carries, if the token is known. */
	private bearer(req: Request) {
		const header = req.headers.get('authorization') ?? '';
		return header.startsWith('Bearer ') ? this.tokens.get(header.slice(7)) : undefined;
	}

	/** serverFor is the MCP server task id's agent sees. */
	private serverFor(id: string) {
		const svc = this.svc;
		const t = svc.store.task(id);
		const delegate = !!t && mayDelegate(svc, t);
		let instructions = 'Mob runs this coding task. When you finish what you were asked, report how it ended with task_result; whoever gave you the task reads it.';
		if (delegate) instructions += ' The other tools hand parts of your work to other coding agents, each in its own worktree and branch of the same project. The owner approves every sub-task first; Mob tells you when all your sub-tasks have ended, with how each said it ended.';
		const server = new McpServer({ name: mcpName, version }, { instructions });
		server.registerTool('task_result', {
			description: 'Report how your task ended: passed, rework or blocked, with a short summary. Call it once you finish what you were asked, as your last step; calling it again replaces what you said.',
			inputSchema: {
				outcome: z.string().describe('passed: your work is done and holds up, or what you reviewed needs no changes; rework: your work, or what you reviewed, needs the changes you list; blocked: you cannot go on without a decision or something you lack'),
				summary: z.string().describe('What you did or found, in a few lines: for rework the changes needed, most important first; for blocked what you need'),
			},
		}, input => answer(() => { this.record(id, input.outcome, input.summary); return 'Recorded.'; }));
		if (!delegate) return server;
		server.registerTool('task_start', {
			description: `Ask the owner to approve handing part of your work to another coding agent, in a new worktree and branch of this project, or read-only in your own worktree (workspace shared), such as to review your work. Returns at once; the sub-task starts once the owner approves, and Mob sends you a summary when all your sub-tasks have ended. At most ${subtaskActive} run at once and ${subtaskTotal} in all.`,
			inputSchema: {
				title: z.string().describe('A short title for the sub-task'),
				prompt: z.string().describe("What the sub-task's agent should do, with everything it needs to know"),
				agent: z.string().optional().describe('The coding agent to use, such as codex or claude; yours when empty'),
				workspace: z.string().optional().describe('new (default): a new worktree and branch; shared: work read-only in your worktree and branch, seeing your uncommitted changes, such as to review your work. A shared sub-task\'s edits are refused.'),
			},
		}, input => answer(() => this.ask(id, input)));
		server.registerTool('tasks', {
			description: 'List the sub-tasks you started, with their status (running, waiting for the owner, review when done, stopped, failed), how each said its work ended (passed, needs rework, blocked), branch, its result or latest reply and what they used.',
		}, () => answer(() => this.list(id)));
		server.registerTool('task_message', {
			description: "Send one of your sub-tasks' agents more instructions; it works on them on its own.",
			inputSchema: { task: z.string().describe("The sub-task's ID"), text: z.string().describe('The instructions') },
		}, input => answer(async () => {
			const child = this.subtask(id, input.task);
			if (!input.text.trim()) throw new Error('text is empty');
			await svc.message(child.id, input.text);
			return 'Sent.';
		}));
		server.registerTool('task_stop', {
			description: "Stop one of your sub-tasks' agents. Its branch and worktree stay.",
			inputSchema: { task: z.string().describe("The sub-task's ID") },
		}, input => answer(() => { svc.stopTask(this.subtask(id, input.task).id); return 'Stopped.'; }));
		return server;
	}

	/** record saves how task id's agent said its work ended. */
	private record(id: string, outcome: string, summary: string) {
		outcome = outcome.trim().toLowerCase();
		summary = summary.trim();
		if (![outcomePassed, outcomeRework, outcomeBlocked].includes(outcome)) throw new Error(`outcome is passed, rework or blocked, not ${JSON.stringify(outcome)}`);
		const chars = [...summary];
		if (chars.length > resultLimit) summary = chars.slice(0, resultLimit).join('') + '…';
		this.svc.store.setTaskResult(id, outcome, summary);
	}

	/** subtask is the task child, if task id started it. */
	subtask(id: string, child: string): Task {
		const parent = this.svc.store.task(id);
		if (!parent) throw new Error(`no task ${id}`);
		const c = this.svc.store.task(child);
		if (!c || c.id !== child || c.parent !== parent.conversationId) throw new Error(`no sub-task ${child} of yours`);
		return c;
	}

	/** ask asks the owner, in task id's conversation, to approve starting a sub-task, and starts it once they do. */
	private ask(id: string, input: { title: string; prompt: string; agent?: string; workspace?: string }): string {
		const svc = this.svc;
		const t = svc.store.task(id);
		if (!t) throw new Error(`no task ${id}`);
		if (!mayDelegate(svc, t)) throw new Error('a sub-task cannot start sub-tasks of its own');
		const prompt = input.prompt.trim();
		let title = input.title.trim(), agent = (input.agent ?? '').trim();
		if (!prompt) throw new Error('prompt is empty');
		const workspace = input.workspace ?? '';
		if (workspace !== '' && workspace !== 'new' && workspace !== 'shared') throw new Error(`workspace is new or shared, not ${JSON.stringify(workspace)}`);
		const shared = workspace === 'shared';
		if (!agent) {
			agent = t.agent;
			try { if (shared && !preset(agent).readOnly) agent = readers()[0]!; } catch { /* checked below */ }
		}
		const a = preset(agent);
		if (shared && !a.readOnly) throw new Error(`${a.title} cannot work read-only; use ${readers().join(' or ')}`);
		title ||= firstLine(prompt, 60);
		// Checked again when the owner approves, which may be much later.
		this.room(t, 0);
		const session = svc.running(t.id);
		if (!session) throw new Error('your session is not running');
		const call = 'mob-subtask-' + newID();
		const shown: Record<string, unknown> = { agent: a.name, project: t.project, title, prompt };
		if (shared) shown.workspace = 'read-only in ' + t.worktree;
		void session.askOwner(call, (shared ? 'Start a read-only sub-task: ' : 'Start a sub-task: ') + title, shown).then(async outcome => {
			if (outcome.outcome !== 'selected' || !outcome.optionId.startsWith('allow')) return session.report(call, false, 'The owner did not approve this sub-task.');
			try {
				this.reserve(t);
				let child: Task;
				try {
					child = shared ? await svc.startReader(t.conversationId, t, a.name, title, prompt) : await svc.startTask(t.conversationId, t.project, a.name, title, prompt);
				} finally { this.release(t); }
				session.report(call, true, `Started sub-task ${child.id} on branch ${child.branch}.`);
			} catch (e) {
				session.report(call, false, 'The sub-task did not start: ' + (e as Error).message);
			}
		});
		return `Asked the owner to approve sub-task ${JSON.stringify(title)} (${a.title}). It starts once they approve; Mob sends you a summary when all your sub-tasks have ended, and tasks lists them meanwhile.`;
	}

	/** room throws why task t may not start another sub-task, counting the starting ones too, if it may not. */
	room(t: Task, starting: number) {
		const kids = children(this.svc, t);
		const active = starting + kids.filter(c => c.status === taskRunning || c.status === taskWaiting).length;
		if (kids.length + starting >= subtaskTotal) throw new Error(`you started ${subtaskTotal} sub-tasks, the most a task may`);
		if (active >= subtaskActive) throw new Error(`${active} of your sub-tasks are at work or starting, the most at once; wait for one to end`);
	}

	/** reserve holds a place for a sub-task of t that is about to start, so that approvals decided together cannot pass the limits; release gives it back once the sub-task has started or failed to. */
	reserve(t: Task) {
		const n = this.starting.get(t.id) ?? 0;
		this.room(t, n);
		this.starting.set(t.id, n + 1);
	}

	release(t: Task) {
		const n = (this.starting.get(t.id) ?? 0) - 1;
		if (n <= 0) this.starting.delete(t.id);
		else this.starting.set(t.id, n);
	}

	/** list is what tasks tells task id's agent. */
	private list(id: string) {
		const t = this.svc.store.task(id);
		if (!t) throw new Error(`no task ${id}`);
		const kids = children(this.svc, t);
		return kids.length ? report(this.svc, kids) : 'You started no sub-tasks.';
	}
}

/** mayDelegate reports whether task t may start sub-tasks: only a task Mob's conversation started may, so the tree is at most two agents deep. */
const mayDelegate = (svc: Service, t: Task) => !!t.parent && !svc.owns(t.parent);

/** children are the tasks task t's conversation started. */
const children = (svc: Service, t: Task) => svc.store.tasks(t.project).filter(c => c.parent === t.conversationId);

/** report lists tasks with their status, branch, what they used and their latest reply. */
export function report(svc: Service, list: Task[]) {
	const used = svc.store.conversationUsage(...list.map(t => t.conversationId));
	let b = '';
	for (const t of list) {
		b += `- **${label(t)}** · ${t.agent} · ${t.title} (task ${t.id}, branch \`${t.branch}\`)`;
		const u = used.get(t.conversationId);
		if (u) b += ' · ' + brief(u);
		b += '\n';
		// What the agent reported is its account; otherwise the end of what it last said.
		let said = t.result ?? '';
		if (!said) {
			said = svc.store.lastReply(t.conversationId).trim();
			const chars = [...said];
			if (chars.length > reportReply) said = '…' + chars.slice(-reportReply).join('');
		}
		if (said) b += '  ' + said.replaceAll('\n', '\n  ') + '\n';
	}
	return b.replace(/\n+$/, '');
}

const summaryPrompt = (text: string) => `Automatic update from Mob, not written by the owner: all the sub-tasks you started have ended, each with how it said its work ended (passed, needs rework or blocked) when it did. Their branches are in this project; review and bring in what you need, act on what they found, then finish your own work.\n\n${text}`;

/**
 * settle tells the conversation that started task id when every task it
 * started has ended: the agent of a task, which then goes on; or, for Mob's
 * own conversation that started more than one, a summary in it and a notice.
 */
export function settle(svc: Service, id: string) {
	const t = svc.store.task(id);
	if (!t?.parent) return;
	const siblings = svc.store.tasks().filter(c => c.parent === t.parent);
	if (siblings.some(c => c.status === taskRunning || c.status === taskWaiting)) return;
	// Each set of ended tasks is reported once, however many end together.
	siblings.sort((a, b) => a.createdAt - b.createdAt);
	// A task that ends again, after more work, is news again.
	const key = siblings.map(c => `${c.id}:${c.status}:${c.updatedAt} `).join('');
	if (svc.hub.settled.get(t.parent) === key) return;
	svc.hub.settled.set(t.parent, key);
	const text = report(svc, siblings);
	const parent = svc.store.task(t.parent);
	if (parent && parent.conversationId === t.parent) { void tell(svc, parent.id, summaryPrompt(text)); return; }
	// One task's end is news enough.
	if (siblings.length < 2) return;
	const summary = `**All ${siblings.length} tasks started here have ended.**\n\n${text}`;
	try { svc.store.note(t.parent, summary); } catch (e) {
		console.warn(`summarize ended tasks in ${t.parent}: ${(e as Error).message}`);
		return;
	}
	svc.conversations.notify({ conversationId: t.parent, text: summary });
}

/** tell hands task id's agent the summary of its ended sub-tasks, once the turn its conversation may still be finishing has ended. */
async function tell(svc: Service, id: string, prompt: string) {
	for (let attempt = 0; attempt < tellTries; attempt++) {
		let parent = svc.store.task(id);
		if (!parent) return;
		await svc.conversations.watch(parent.conversationId)?.whenDone();
		if (svc.running(parent.id)?.enqueue(prompt)) {
			// The agent at work reads it once its prompt ends.
			svc.store.say(parent.conversationId, prompt);
			return;
		}
		// An agent the owner stopped stays stopped, and one waiting for a decision keeps waiting: a message would answer no to it.
		parent = svc.store.task(id);
		if (parent?.status !== taskReview) return;
		try { await svc.message(parent.id, prompt); return; } catch (e) {
			if (!(e instanceof CommandError && e.status === 409)) { console.warn(`tell task ${id} its sub-tasks ended: ${(e as Error).message}`); return; }
		}
	}
}
