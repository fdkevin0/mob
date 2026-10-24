// The coding agent service: tasks are conversations an outside coding agent
// answers, each working in its own git worktree of a project.
import {
	Aborted, brief, isAbort, newID, taskFailed, taskReview, taskRunning, taskStopped, taskWaiting,
	type Answer, type ConversationService, type Decision, type Delegate, type DelegateTurn, type Notice, type Store, type Task, type Tasks,
} from '@mob/core';
import { mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { firstLine, git, slug, start, type Conn } from './process';
import { preset, presets, readers, type Preset } from './presets';
import { Session } from './session';
import { review } from './review';
import type { Squad } from './squad';
import { children, Hub, settle } from './subtasks';
import { tree } from './tree';

/** Project is a git repository tasks work on. Projects are saved in the "projects" setting. */
export type Project = { name: string; path: string };

/** startWait is how long a message waits for an agent that is starting. */
const startWait = 30_000;
/** noticeLimit bounds the agent's words a notice repeats, in characters. */
export const noticeLimit = 1200;

const stopping = () => new Error('Mob is stopping');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Service implements Delegate, Tasks {
	/** sessions are the agents running, by task ID. */
	private sessions = new Map<string, Session>();
	closed = false;
	/** checked is when an agent's command was last looked for; found whether one was installed. */
	private checked = 0;
	private found = false;
	/** reviews counts the reviews started on their own, by task ID. */
	reviews = new Map<string, number>();
	/** hub is the MCP server for sub-tasks and results. */
	readonly hub = new Hub(this);
	/** squads are the review squads at work, by the ID of the task they review. */
	readonly squads = new Map<string, Squad>();
	/** reviewers are the tasks started as squads' reviewers, which report to their squad rather than to the task they review. */
	readonly reviewers = new Set<string>();
	/** launched, when set by a test, runs once a task's agent was handed its first prompt. */
	launched?: (t: Task) => Promise<void> | void;

	constructor(readonly store: Store, readonly conversations: ConversationService,
		/** dir holds the tasks' worktrees, under worktrees/. */
		readonly dir: string,
		/** connect starts an agent in dir; unset runs its preset's command. */
		readonly connect?: (p: Preset, dir: string, signal: AbortSignal) => Promise<Conn>) {}

	/** task is the task whose conversation is conversationID. */
	private taskOf(conversationID: string) {
		const t = this.store.task(conversationID);
		return t && t.conversationId === conversationID ? t : undefined;
	}

	owns(conversationID: string) { return !!this.taskOf(conversationID); }
	label(conversationID: string) { return this.taskOf(conversationID)?.agent ?? ''; }

	async reply(turn: DelegateTurn, signal: AbortSignal) {
		const t = this.taskOf(turn.conversationId);
		if (!t) throw new Error('no task answers this conversation');
		if (!turn.text && !this.running(t.id)) {
			// A decision reached no agent: it stopped, or Mob restarted, while the approval waited. Only the owner's next message starts one.
			return turn.stream('text', 'The agent stopped before this was decided; send the task a message to continue.');
		}
		let err: unknown;
		let session: Session | undefined;
		try {
			session = await this.session(t, signal);
			await session.reply(turn, signal);
		} catch (e) {
			err = e;
			// Stopped while the agent was starting, or it could not start.
			if (!session) this.store.setTaskStatus(t.id, signal.aborted ? taskStopped : taskFailed);
		}
		// Stopping a task is the owner's doing; it raises no notice.
		if (!signal.aborted && !isAbort(err)) this.notify(t.id, turn, err as Error | undefined);
		void (async () => {
			// The summary repeats the reply this turn saves once it ends.
			await this.conversations.watch(t.conversationId)?.whenDone();
			settle(this, t.id);
			this.ended(t.id);
		})();
		if (err) throw err;
	}

	/** notify tells the owner, in the messaging apps they use, that task id's turn ended waiting for a decision, done or failed. */
	private notify(id: string, turn: DelegateTurn, failure?: Error) {
		const t = this.store.task(id);
		if (!t) return;
		const n: Notice = { conversationId: t.conversationId, text: '', channel: turn.channel };
		const title = `${t.agent} · ${t.title}`;
		let said = turn.conclusion().trim();
		const chars = [...said];
		if (chars.length > noticeLimit) said = '…' + chars.slice(-noticeLimit).join('');
		if (t.status === taskFailed && failure) n.text = '**Task failed:** ' + title + '\n\n' + failure.message;
		// The agent ended early but can go on, such as at its limit.
		else if (failure) n.text = '**Task stopped early:** ' + title + '\n\n' + failure.message;
		else if (t.status === taskWaiting) {
			n.approvals = this.conversations.pending(t.conversationId);
			if (!n.approvals.length) return;
			n.text = '**Task waits for your decision:** ' + title;
		} else if (t.status === taskReview && this.reviewers.has(t.id)) {
			// A reviewer's report reaches the owner with its squad's.
			return;
		} else if (t.status === taskReview && turn.wrote()) {
			// Mob's model checks the work first and tells the owner what it found.
			if (this.review(t)) return;
			n.text = '**Task done:** ' + title + '\nBranch `' + t.branch + '`';
			const u = this.store.conversationUsage(t.conversationId).get(t.conversationId);
			if (u) n.text += ' · ' + brief(u);
		} else return;
		if (said && t.status !== taskFailed) n.text += '\n\n' + said;
		this.conversations.notify(n);
	}

	/** review has Mob's model review a finished task. */
	review(t: Task) { return review(this, t); }

	decide(conversationID: string, d: Decision, a: Answer) {
		const t = this.taskOf(conversationID);
		if (!t) throw new Error('no task answers this conversation');
		if (this.running(t.id)?.decide(d, a)) return;
		// The agent stopped waiting, such as when Mob restarted, so the approved call never ran.
		if (a.approved) this.store.complete(d, undefined, '', new Error('the agent stopped before this was decided'));
	}

	/** session is the running agent of task t, started and its session loaded or created when there is none. */
	private async session(t: Task, signal: AbortSignal): Promise<Session> {
		if (this.closed) throw stopping();
		const running = this.sessions.get(t.id);
		if (running) return running;
		const p = preset(t.agent);
		const conn = await (this.connect ? this.connect(p, t.worktree, signal) : Promise.resolve(start(p, t.worktree)));
		if (signal.aborted) { conn.stop(); throw signal.reason instanceof Error ? signal.reason : new Aborted(); }
		const s = await Session.open(this, p, t, conn, signal);
		if (this.closed) { s.close(); throw stopping(); }
		this.sessions.set(t.id, s);
		return s;
	}

	/** drop ends the agent of task id, if it runs. */
	drop(id: string, s: Session) {
		if (this.sessions.get(id) === s) this.sessions.delete(id);
		s.close();
	}

	/** reap ends the agents of the tasks in list whose work has ended, now that whoever started them has their reports; their worktrees and branches stay, and a message to one starts its agent again. */
	reap(list: Task[]) {
		for (const c of list) {
			const t = this.store.task(c.id);
			if (!t || t.status === taskRunning || t.status === taskWaiting || this.conversations.isActive(t.conversationId)) continue;
			const s = this.running(t.id);
			if (s) this.drop(t.id, s);
		}
	}

	/** retire reaps the agents of task id's sub-tasks once it and they have all ended, which delivers its work; its squads' reviewers are their squads' to reap. */
	retire(id: string) {
		const t = this.store.task(id);
		if (!t || t.status === taskRunning || t.status === taskWaiting) return;
		const kids = children(this, t).filter(c => !this.reviewers.has(c.id));
		if (kids.some(c => c.status === taskRunning || c.status === taskWaiting)) return;
		this.reap(kids);
	}

	/** ended reaps what task id's end lets go: its sub-tasks' agents, and its own and its siblings' when the task that started them stopped or failed, since no turn of that task's follows to do it. */
	private ended(id: string) {
		this.retire(id);
		const t = this.store.task(id);
		const lead = t?.parent ? this.store.task(t.parent) : undefined;
		if (lead && lead.conversationId === t!.parent && (lead.status === taskStopped || lead.status === taskFailed)) this.retire(lead.id);
	}

	/** close ends every agent. */
	close() {
		this.closed = true;
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		this.hub.close();
		for (const s of sessions) s.close();
	}

	/** shutdown stops the tasks' turns, which then stop their agents, and closes. */
	async shutdown() {
		this.closed = true;
		const runs = [...this.sessions.values()].map(s => {
			const run = this.conversations.watch(s.task.conversationId);
			this.conversations.stop(s.task.conversationId);
			return run?.whenDone();
		});
		await Promise.all(runs);
		this.close();
	}

	running(id: string) { return this.sessions.get(id); }

	/** mcpServers are the MCP servers a session of task t gets. */
	mcpServers(t: Task, http: boolean) { return this.hub.servers(t, http); }
	forget(token: string) { this.hub.forget(token); }

	/** sessionModel is the model task id's running session selects, if any. */
	sessionModel(id: string) { return this.sessions.get(id)?.model ?? ''; }

	// Projects.

	projects(): Project[] { return this.store.setting<Project[]>('projects') ?? []; }

	/** project finds a saved project by name, or by its path. */
	project(name: string) { return this.projects().find(p => p.name === name || p.path === name); }

	/** addProject saves the git repository at path as a project called name, or after its directory when name is empty. */
	async addProject(path: string, name = ''): Promise<Project> {
		if (!isAbsolute(path)) throw new Error('project path must be absolute');
		let top: string;
		try { top = await git(path, 'rev-parse', '--show-toplevel'); } catch (e) { throw new Error(`${path} is not a git repository: ${(e as Error).message}`); }
		name = (name || basename(top)).trim();
		if (!name || /[ \t\n/]/.test(name) || name.length > 64) throw new Error('project names are up to 64 characters without spaces or slashes');
		const list = this.projects();
		const known = list.find(p => p.name === name || p.path === top);
		if (known) return known;
		const p = { name, path: top };
		this.store.saveSetting('projects', [...list, p]);
		return p;
	}

	/** removeProject forgets project name; its tasks and worktrees stay. */
	removeProject(name: string) {
		const list = this.projects();
		const kept = list.filter(p => p.name !== name);
		if (kept.length === list.length) throw new Error(`no project is called ${name}`);
		this.store.saveSetting('projects', kept);
	}

	/** worktree makes a new branch for a task, checked out in its own directory under dir. */
	private async worktree(p: Project, title: string) {
		if (!this.dir) throw new Error('coding agents need a data directory');
		const id = newID().slice(0, 8);
		const branch = 'mob/' + slug(title) + '-' + id;
		const dir = join(this.dir, 'worktrees', p.name + '-' + id);
		mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
		try { await git(p.path, 'worktree', 'add', '-b', branch, dir, 'HEAD'); } catch (e) { throw new Error(`create a worktree of ${p.name}: ${(e as Error).message}`); }
		return { dir, branch };
	}

	// Tasks.

	/** startTask makes a worktree of project for a new task and hands prompt to the agent in a turn that runs on its own. parent is the conversation that started it, if any. */
	async startTask(parent: string, project: string, agent: string, title: string, prompt: string): Promise<Task> {
		const p = this.project(project) ?? await this.addProject(project);
		const a = preset(agent);
		title = title.trim() || firstLine(prompt, 60);
		const { dir, branch } = await this.worktree(p, title);
		return this.launch({ project: p.name, agent: a.name, title, worktree: dir, branch, status: taskRunning, parent: parent || undefined }, prompt);
	}

	/** startReader starts a read-only task in the worktree and branch of task base, such as to review its work, and hands prompt to the agent. parent is the conversation that started it. */
	async startReader(parent: string, base: Task, agent: string, title: string, prompt: string, saved?: (t: Task) => void): Promise<Task> {
		const a = preset(agent);
		if (!a.readOnly) throw new Error(`${a.title} cannot work read-only; use ${readers().join(' or ')}`);
		if (base.readOnly) throw new Error("a read-only task's worktree is another task's; share that task's instead");
		title = title.trim() || firstLine(prompt, 60);
		return this.launch({ project: base.project, agent: a.name, title, worktree: base.worktree, branch: base.branch, status: taskRunning, parent: parent || undefined, readOnly: true }, prompt, saved);
	}

	/** launch saves task t and hands prompt to its agent; saved, if set, is called with the task in between, so that its agent's turn, which may end before launch returns, finds what saved recorded. */
	private async launch(t: Omit<Task, 'id' | 'conversationId' | 'createdAt' | 'updatedAt'>, prompt: string, saved?: (t: Task) => void): Promise<Task> {
		const task = this.store.createTask(t);
		saved?.(task);
		try { await this.message(task.id, prompt); } catch (e) {
			this.store.setTaskStatus(task.id, taskFailed);
			throw e;
		}
		await this.launched?.(task);
		return task;
	}

	/** message hands text to task id's agent in a turn that runs on its own; signal also ends a turn it starts, such as when the token that asked for it is revoked. */
	async message(id: string, text: string, signal?: AbortSignal) {
		const t = this.store.task(id);
		if (!t || t.id !== id) throw new Error(`no task ${id}`);
		// An agent at work takes the text once its current prompt ends, in the turn already following it. A turn that has just begun may still be starting the agent.
		const wait = Date.now() + startWait;
		while (this.conversations.isActive(t.conversationId)) {
			if (this.running(t.id)?.enqueue(text)) return this.store.say(t.conversationId, text);
			if (Date.now() > wait) throw new Error('the agent is still starting; try again shortly');
			await sleep(20);
		}
		await this.conversations.start({ id: t.conversationId, text, requestId: newID(), owner: true }, signal);
	}

	/** recover records the tasks that were running or waiting when Mob last stopped as stopped: their agents ended with it. */
	recover() { this.store.stopTasks(); }

	/** stopTask stops task id's turn and its agent. */
	stopTask(id: string) {
		const t = this.store.task(id);
		if (!t || t.id !== id) throw new Error(`no task ${id}`);
		this.conversations.stop(t.conversationId);
		const s = this.running(t.id);
		if (s) this.drop(t.id, s);
		this.store.setTaskStatus(t.id, taskStopped);
		settle(this, t.id);
		this.ended(t.id);
	}

	/** offered reports whether task_start is offered: once there are projects or tasks, or while a coding agent can be started. */
	offered = () => this.busy() || this.installed();

	/** installed reports whether some agent's command is installed, looking again at most once a minute. */
	private installed() {
		if (Date.now() - this.checked > 60_000) {
			this.checked = Date.now();
			this.found = presets.some(p => p.commands.some(c => Bun.which(c[0]!)));
		}
		return this.found;
	}

	/** busy reports whether there are projects or tasks to follow; until then only task_start is offered. */
	busy = () => this.projects().length > 0 || this.store.tasks().length > 0;

	tree(project: string) { return tree(this, project); }
}
