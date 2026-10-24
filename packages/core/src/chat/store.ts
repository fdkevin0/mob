// The conversation store: conversations, messages, approvals, facts, grants,
// tasks, usage, schedules, deliveries and settings, in one SQLite database.
import type { Usage as ModelUsage } from '../llm/llm';
import { Changes } from './changes';
import { schema, schemaVersion, SchemaError, upgrades } from './schema';
import { newID, NotFound, type SQL } from './sql';

export type Part = Record<string, any>;

export type Message = {
	id: string;
	role: string;
	parts: Part[];
	metadata?: Record<string, unknown>;
	/** model answered an assistant message; usage is what its steps cost. Not sent to clients. */
	model?: string;
	usage?: ModelUsage;
	command?: boolean;
};

/** wire is the message as clients see it, without the store's own fields. */
export const wire = (m: Message) => (m.metadata ? { id: m.id, role: m.role, parts: m.parts, metadata: m.metadata } : { id: m.id, role: m.role, parts: m.parts });

export type Conversation = { id: string; title: string; updatedAt: number };

/** Summary is a conversation's earlier messages summarized, through message `through`, for models to read in their place. */
export type Summary = { text: string; through: string };

/**
 * Transfer is a conversation as it moves from one Mob to another, such as from
 * the browser to a runner: its transcript, summary, model, facts and usage.
 * Approvals, grants, tasks and schedules stay behind, since they belong to the
 * Mob that made them.
 */
export type Transfer = {
	v: 1;
	title: string;
	model: string;
	summary: string;
	summaryThrough: string;
	messages: { id: string; role: string; parts: string; status: string; error: string; model: string; usage: string; kind: string }[];
	facts: { fact: string; owner: boolean }[];
	usage: { messageId: string; session: string; model: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number; durationMs: number; createdAt: number }[];
};

/** TransferError says why a conversation cannot move now. */
export class TransferError extends Error {}

/** Decision is an approval the user has just decided. */
export type Decision = { approvalId: string; messageId: string; toolCallId: string; tool: string; input: string };

export class StaleApproval extends Error {
	constructor() { super('approval is unknown, expired, or already decided'); }
}
export const isStaleApproval = (e: unknown) => e instanceof StaleApproval;

export type Fact = { id: string; conversationId: string; text: string; owner: boolean };
export type Grant = { id: string; conversationId: string; tool: string; scope: string; created: number };

/** How long an approval is remembered, as Answer.remember says. */
export const rememberConversation = 'conversation';
export const rememberAlways = 'always';

export type PlanEntry = { content: string; status: string };
export type Task = {
	id: string;
	conversationId: string;
	project: string;
	agent: string;
	title: string;
	worktree: string;
	branch: string;
	session?: string;
	status: string;
	parent?: string;
	/** readOnly tasks work in another task's worktree and branch without changing them, such as to review it. */
	readOnly?: boolean;
	/** outcome is how the agent said its latest work ended, with result its account of it; both unset until it says, and again once it is given more work. */
	outcome?: string;
	result?: string;
	plan?: PlanEntry[];
	createdAt: number;
	updatedAt: number;
};
export const taskRunning = 'running', taskWaiting = 'waiting', taskReview = 'review', taskStopped = 'stopped', taskFailed = 'failed';
/** How an agent says its work ended: done and holds up; needs the changes its result lists; cannot go on without a decision or something it lacks. */
export const outcomePassed = 'passed', outcomeRework = 'rework', outcomeBlocked = 'blocked';

export type Schedule = { id: string; conversationId: string; prompt: string; next: number; repeat?: string; zone?: string; clock?: string; createdAt: number };
export type Delivery = { id: string; state: string; reply: string; error: string; updatedAt: number };

/** Usage is what a set of model requests used; total is input and output. */
export type Usage = {
	totalTokens: number; inputTokens: number; outputTokens: number; reasoningTokens: number;
	cacheReadTokens: number; cacheWriteTokens: number; cost: number; durationMs: number; requests: number;
};
export type ModelUsageRow = { model: string } & Usage;
export type UsageSummary = Usage & { turns: number; models: ModelUsageRow[] };
export type DayUsage = { date: string } & Usage;
export type TopConversation = { id: string; title: string; agent?: string } & Usage & { turns: number };
export type UsageReport = UsageSummary & { since: number; firstDay: string; lastDay: string; conversations: number; days: DayUsage[]; top: TopConversation[] };

export const zeroUsage = (): Usage => ({ totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, durationMs: 0, requests: 0 });
export function addUsage(u: Usage, v: Usage): Usage {
	return {
		totalTokens: u.totalTokens + v.totalTokens, inputTokens: u.inputTokens + v.inputTokens, outputTokens: u.outputTokens + v.outputTokens,
		reasoningTokens: u.reasoningTokens + v.reasoningTokens, cacheReadTokens: u.cacheReadTokens + v.cacheReadTokens,
		cacheWriteTokens: u.cacheWriteTokens + v.cacheWriteTokens, cost: u.cost + v.cost, durationMs: u.durationMs + v.durationMs, requests: u.requests + v.requests,
	};
}

/** text joins a message's text parts. */
export const textOf = (m: { parts: Part[] }) => m.parts.filter(p => p.type === 'text').map(p => String(p.text ?? '')).join('');

/** expiredApproval is what the model and the user see for a call whose approval expired undecided. */
const expiredApproval = 'The approval expired before the user decided; ask again if it is still needed.';

const usageColumns = 'SUM(input) AS i,SUM(output) AS o,SUM(reasoning) AS r,SUM(cache_read) AS cr,SUM(cache_write) AS cw,SUM(cost) AS c,SUM(duration_ms) AS d,SUM(input+output>0) AS n';
type UsageRow = { i: number; o: number; r: number; cr: number; cw: number; c: number; d: number; n: number };
const usageOf = (row: UsageRow): Usage => ({
	totalTokens: (row.i ?? 0) + (row.o ?? 0), inputTokens: row.i ?? 0, outputTokens: row.o ?? 0, reasoningTokens: row.r ?? 0,
	cacheReadTokens: row.cr ?? 0, cacheWriteTokens: row.cw ?? 0, cost: row.c ?? 0, durationMs: row.d ?? 0, requests: row.n ?? 0,
});

const taskColumns = 'id,conversation_id,project,agent,title,worktree,branch,session,status,parent_id,read_only,outcome,result,plan,created_at,updated_at';
type TaskRow = { id: string; conversation_id: string; project: string; agent: string; title: string; worktree: string; branch: string; session: string; status: string; parent_id: string; read_only: number; outcome: string; result: string; plan: string; created_at: number; updated_at: number };
function taskOf(r: TaskRow): Task {
	const t: Task = { id: r.id, conversationId: r.conversation_id, project: r.project, agent: r.agent, title: r.title, worktree: r.worktree, branch: r.branch, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
	if (r.session) t.session = r.session;
	if (r.parent_id) t.parent = r.parent_id;
	if (r.read_only) t.readOnly = true;
	if (r.outcome) { t.outcome = r.outcome; t.result = r.result; }
	if (r.plan) t.plan = JSON.parse(r.plan);
	return t;
}

const scheduleColumns = 'id,conversation_id,prompt,next,repeat,zone,clock,created_at';
type ScheduleRow = { id: string; conversation_id: string; prompt: string; next: number; repeat: string; zone: string; clock: string; created_at: number };
function scheduleOf(r: ScheduleRow): Schedule {
	const s: Schedule = { id: r.id, conversationId: r.conversation_id, prompt: r.prompt, next: r.next, createdAt: r.created_at };
	if (r.repeat) s.repeat = r.repeat;
	if (r.zone) s.zone = r.zone;
	if (r.clock) s.clock = r.clock;
	return s;
}

const title60 = (text: string) => [...text].slice(0, 60).join('');

/** localDate is a local calendar day as YYYY-MM-DD. */
export function localDate(d: Date) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class Store {
	/** changes tells clients what each write changed. */
	readonly changes = new Changes();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private closed = false;

	constructor(readonly db: SQL, private release = 'dev') {}

	/** open prepares the database: schema, and what a stopped service left unfinished. */
	open(): this {
		const db = this.db;
		db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
		const version = db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
		const tables = db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT IN ('meta','sqlite_sequence')")!.n;
		const opened = tables ? (() => { try { return db.get<{ value: string }>("SELECT value FROM meta WHERE key='service_version'")?.value ?? ''; } catch { return ''; } })() : '';
		if (version > schemaVersion) throw new SchemaError(`This database has schema ${version}, last opened by ${opened ? 'Mob ' + opened : 'an unknown release'}. Mob ${this.release} reads schema ${schemaVersion} and older; install ${opened ? 'Mob ' + opened + ' or newer' : 'a newer release'}.`);
		if (tables && version < 10) throw new SchemaError(`This database has schema ${version}, which Mob ${this.release} does not upgrade. Start it with a Go release of Mob once to upgrade it.`);
		db.transaction(() => {
			if (tables) for (let v = version + 1; v <= schemaVersion; v++) db.exec(upgrades[v]!);
			db.exec(schema);
			db.exec(`PRAGMA user_version=${schemaVersion}`);
			db.run("INSERT INTO meta(key,value) VALUES('service_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", this.release);
		});
		db.exec(`UPDATE messages SET status='interrupted', error='The service stopped before this reply completed.' WHERE status='streaming'; UPDATE deliveries SET state='failed-or-unknown',error='Service stopped during send; recipient outcome is unknown.' WHERE state='sending'; UPDATE deliveries SET state='processing-failed',error='Service stopped during processing; send a new message to continue.' WHERE state='processing';`);
		this.recoverApprovals();
		for (const { conversation_id } of db.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM approvals WHERE status='pending'")) this.scheduleExpiry(conversation_id);
		return this;
	}

	close() {
		this.closed = true;
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.db.close();
	}

	create(): Conversation {
		const c = { id: newID(), title: 'New conversation', updatedAt: Date.now() };
		this.db.run('INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)', c.id, c.title, c.updatedAt);
		this.changes.conversation(c.id, true);
		return c;
	}

	list(): Conversation[] {
		return this.db.all<{ id: string; title: string; updated_at: number }>('SELECT id,title,updated_at FROM conversations ORDER BY updated_at DESC,id').map(r => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
	}

	exists(id: string) { return !!this.db.get('SELECT id FROM conversations WHERE id=?', id); }

	history(id: string): Message[] {
		if (!this.exists(id)) throw new NotFound();
		return this.db.all<{ id: string; role: string; parts: string; status: string; error: string; model: string; usage: string; kind: string }>('SELECT id,role,parts,status,error,model,usage,kind FROM messages WHERE conversation_id=? ORDER BY seq', id).map(r => {
			const m: Message = { id: r.id, role: r.role, parts: JSON.parse(r.parts), metadata: { status: r.status } };
			if (r.error) m.metadata!.error = r.error;
			if (r.model) { m.model = r.model; m.metadata!.model = r.model; }
			if (r.usage) { try { m.usage = JSON.parse(r.usage); m.metadata!.usage = m.usage; } catch { /* ignore */ } }
			if (r.kind === 'command') { m.command = true; m.metadata!.command = true; }
			return m;
		});
	}

	/** begin records the user's text and an empty assistant reply by model. */
	begin(id: string, requestID: string, text: string, model: string): Message {
		const m: Message = { id: newID(), role: 'assistant', parts: [], model };
		this.db.transaction(() => {
			if (text) {
				this.db.run("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'user',?,'complete')", requestID, id, JSON.stringify([{ type: 'text', text }]));
				this.db.run("UPDATE conversations SET title=CASE WHEN title='New conversation' THEN ? ELSE title END,updated_at=? WHERE id=?", title60(text), Date.now(), id);
			}
			this.db.run("INSERT INTO messages(id,conversation_id,role,parts,status,model) VALUES(?,?,'assistant','[]','streaming',?)", m.id, id, model);
		});
		this.changes.conversation(id, text !== '');
		return m;
	}

	/** command records a slash command and its reply. Commands stay in the transcript but are never sent to a model. */
	command(id: string, requestID: string, text: string, reply: string): Message {
		const m: Message = { id: newID(), role: 'assistant', parts: [{ type: 'text', text: reply }], command: true };
		this.db.transaction(() => {
			this.db.run("INSERT INTO messages(id,conversation_id,role,parts,status,kind) VALUES(?,?,'user',?,'complete','command'),(?,?,'assistant',?,'complete','command')", requestID, id, JSON.stringify([{ type: 'text', text }]), m.id, id, JSON.stringify(m.parts));
			this.db.run('UPDATE conversations SET updated_at=? WHERE id=?', Date.now(), id);
		});
		this.changes.conversation(id, true);
		return m;
	}

	save(m: Message, status: string, failure: string) {
		this.db.run('UPDATE messages SET parts=?,status=?,error=?,usage=? WHERE id=?', JSON.stringify(m.parts), status, failure, m.usage ? JSON.stringify(m.usage) : '', m.id);
		this.messageChanged(m.id);
	}

	/** exportConversation copies conversation id for another Mob; one waiting on an approval cannot move. */
	exportConversation(id: string): Transfer {
		const c = this.db.get<{ title: string; model: string; summary: string; summary_through: string }>('SELECT title,model,summary,summary_through FROM conversations WHERE id=?', id);
		if (!c) throw new NotFound();
		if (this.db.get("SELECT 1 FROM approvals WHERE conversation_id=? AND status='pending'", id)) throw new TransferError('This conversation waits for an approval; answer it before moving the conversation.');
		const messages = this.db.all<Transfer['messages'][number]>('SELECT id,role,parts,status,error,model,usage,kind FROM messages WHERE conversation_id=? ORDER BY seq', id);
		const facts = this.db.all<{ fact: string; owner: number }>('SELECT fact,owner FROM memories WHERE conversation_id=? ORDER BY rowid', id).map(r => ({ fact: r.fact, owner: !!r.owner }));
		const usage = this.db.all<{ message_id: string; session: string; model: string; input: number; output: number; reasoning: number; cache_read: number; cache_write: number; cost: number; duration_ms: number; created_at: number }>(
			'SELECT message_id,session,model,input,output,reasoning,cache_read,cache_write,cost,duration_ms,created_at FROM usage WHERE conversation_id=? ORDER BY seq', id,
		).map(u => ({ messageId: u.message_id, session: u.session, model: u.model, input: u.input, output: u.output, reasoning: u.reasoning, cacheRead: u.cache_read, cacheWrite: u.cache_write, cost: u.cost, durationMs: u.duration_ms, createdAt: u.created_at }));
		return { v: 1, title: c.title, model: c.model, summary: c.summary, summaryThrough: c.summary_through, messages, facts, usage };
	}

	/**
	 * importConversation saves a transferred conversation as a new one. Message
	 * IDs this Mob already has, such as when a conversation comes back, are
	 * replaced; a reply that was still streaming arrives interrupted, and an
	 * owner's fact this Mob already keeps is not saved twice.
	 */
	importConversation(t: Transfer): Conversation {
		const str = (v: unknown) => typeof v === 'string';
		const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
		const valid = t?.v === 1 && str(t.title) && str(t.model) && str(t.summary) && str(t.summaryThrough) && Array.isArray(t.messages) && Array.isArray(t.facts) && Array.isArray(t.usage) &&
			t.messages.every(m => ['id', 'role', 'parts', 'status', 'error', 'model', 'usage', 'kind'].every(k => str((m as Record<string, unknown>)[k])) && (m.role === 'user' || m.role === 'assistant')) &&
			t.facts.every(f => str(f.fact) && typeof f.owner === 'boolean') &&
			t.usage.every(u => str(u.messageId) && str(u.session) && str(u.model) && [u.input, u.output, u.reasoning, u.cacheRead, u.cacheWrite, u.cost, u.durationMs, u.createdAt].every(num));
		if (!valid) throw new TransferError('This is not a conversation Mob can import.');
		for (const m of t.messages) { try { if (!Array.isArray(JSON.parse(m.parts))) throw 0; } catch { throw new TransferError('This is not a conversation Mob can import.'); } }
		const c = { id: newID(), title: t.title || 'New conversation', updatedAt: Date.now() };
		const ids = new Map<string, string>();
		this.db.transaction(() => {
			this.db.run('INSERT INTO conversations(id,title,updated_at,model,summary,summary_through) VALUES(?,?,?,?,?,?)', c.id, c.title, c.updatedAt, t.model, '', '');
			for (const m of t.messages) {
				const id = this.hasRequest(m.id) || ids.has(m.id) ? newID() : m.id;
				ids.set(m.id, id);
				const [status, error] = m.status === 'streaming' ? ['interrupted', 'The reply was still being written when the conversation moved.'] : [m.status, m.error];
				this.db.run('INSERT INTO messages(id,conversation_id,role,parts,status,error,model,usage,kind) VALUES(?,?,?,?,?,?,?,?,?)', id, c.id, m.role, m.parts, status, error, m.model, m.usage, m.kind);
			}
			// A summary is kept only while the message it runs through came along.
			if (t.summary && ids.has(t.summaryThrough)) this.db.run('UPDATE conversations SET summary=?,summary_through=? WHERE id=?', t.summary, ids.get(t.summaryThrough)!, c.id);
			for (const f of t.facts) {
				if (f.owner && this.db.get('SELECT 1 FROM memories WHERE owner=1 AND fact=?', f.fact)) continue;
				this.saveFact(newID(), c.id, f.fact, f.owner);
			}
			for (const u of t.usage) {
				this.db.run('INSERT INTO usage(conversation_id,message_id,session,model,input,output,reasoning,cache_read,cache_write,cost,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
					c.id, ids.get(u.messageId) ?? u.messageId, u.session, u.model, u.input, u.output, u.reasoning, u.cacheRead, u.cacheWrite, u.cost, u.durationMs, u.createdAt);
			}
		});
		this.changes.conversation(c.id, true);
		return c;
	}

	/** conversationModel is the model reference /model chose, or "" for the default. */
	conversationModel(id: string): string {
		const row = this.db.get<{ model: string }>('SELECT model FROM conversations WHERE id=?', id);
		if (!row) throw new NotFound();
		return row.model;
	}

	summary(id: string): Summary {
		const row = this.db.get<{ summary: string; summary_through: string }>('SELECT summary,summary_through FROM conversations WHERE id=?', id);
		if (!row) throw new NotFound();
		return { text: row.summary, through: row.summary_through };
	}

	summarize(id: string, sum: Summary) {
		this.db.run('UPDATE conversations SET summary=?,summary_through=? WHERE id=?', sum.text, sum.through, id);
	}

	setConversationModel(id: string, model: string) {
		if (!this.db.run('UPDATE conversations SET model=? WHERE id=?', model, id).changes) throw new NotFound();
		this.changes.conversation(id, false);
	}

	requestApproval(conversationID: string, m: Message, callID: string, input: unknown): string {
		const id = newID();
		for (const part of m.parts) if (part.toolCallId === callID) { part.state = 'approval-requested'; part.approval = { id }; }
		this.db.transaction(() => {
			this.db.run('INSERT INTO approvals(id,conversation_id,message_id,tool_call_id,input,expires_at) VALUES(?,?,?,?,?,?)', id, conversationID, m.id, callID, JSON.stringify(input ?? null), Date.now() + 3600_000);
			this.db.run('UPDATE messages SET parts=? WHERE id=?', JSON.stringify(m.parts), m.id);
		});
		this.changes.conversation(conversationID, false);
		this.scheduleExpiry(conversationID);
		return id;
	}

	/** approvalConversation locates the conversation a saved approval belongs to. */
	approvalConversation(id: string): string {
		const row = this.db.get<{ conversation_id: string }>('SELECT conversation_id FROM approvals WHERE id=?', id);
		if (!row) throw new NotFound('approval not found');
		return row.conversation_id;
	}

	// decide records the user's decision, at most once. A denial completes the
	// call and tells the model, with the user's reason when they gave one; an
	// approved call is left for complete, so a retry never carries it out twice.
	decide(conversationID: string, approvalID: string, approved: boolean, reason: string): Decision {
		return this.decideOnce(conversationID, approvalID, approved, reason, true);
	}

	/** withdraw records a pending approval as denied without telling a model. */
	withdraw(conversationID: string, approvalID: string) { this.decideOnce(conversationID, approvalID, false, '', false); }

	private decideOnce(conversationID: string, approvalID: string, approved: boolean, reason: string, tell: boolean): Decision {
		const d = this.db.transaction(() => {
			const row = this.db.get<{ message_id: string; tool_call_id: string; input: string; status: string; expires_at: number }>('SELECT message_id,tool_call_id,input,status,expires_at FROM approvals WHERE id=? AND conversation_id=?', approvalID, conversationID);
			if (!row || row.status !== 'pending' || row.expires_at < Date.now()) throw new StaleApproval();
			const d: Decision = { approvalId: approvalID, messageId: row.message_id, toolCallId: row.tool_call_id, tool: '', input: row.input };
			this.updatePart(d, p => {
				d.tool = String(p.type).replace(/^tool-/, '');
				p.approval = { id: approvalID, approved };
				p.state = approved ? 'approval-responded' : 'output-denied';
			});
			this.db.run('UPDATE approvals SET status=? WHERE id=?', approved ? 'approved' : 'denied', approvalID);
			if (!approved && tell) {
				const note = reason ? `The user denied the ${d.tool} request and said: ${reason}` : `The user denied the ${d.tool} request. Do not retry unless asked.`;
				this.db.run("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'user',?,'complete')", newID(), conversationID, JSON.stringify([{ type: 'text', text: note }]));
			}
			return d;
		});
		this.changes.conversation(conversationID, false);
		return d;
	}

	/** complete records what an approved call returned and where a large output was saved, if it was. */
	complete(d: Decision, output: unknown, file: string, failure?: Error) {
		this.db.transaction(() => this.updatePart(d, p => {
			if (failure) { p.state = 'output-error'; p.errorText = failure.message; }
			else { p.state = 'output-available'; p.output = output; if (file) p.outputFile = file; }
		}));
		this.messageChanged(d.messageId);
	}

	/** updatePart changes the decided call's part in its stored message; call it in a transaction. */
	private updatePart(d: Pick<Decision, 'messageId' | 'toolCallId'>, change: (p: Part) => void) {
		const row = this.db.get<{ parts: string }>('SELECT parts FROM messages WHERE id=?', d.messageId);
		if (!row) throw new NotFound('message not found');
		const parts: Part[] = JSON.parse(row.parts);
		for (const p of parts) if (p.toolCallId === d.toolCallId) change(p);
		this.db.run('UPDATE messages SET parts=? WHERE id=?', JSON.stringify(parts), d.messageId);
		// A summary that covers the message tells of the call as it was; it is
		// dropped, so the next turn reads the message as it is now.
		this.db.run(`UPDATE conversations SET summary='',summary_through='' WHERE summary_through<>''
		AND id=(SELECT conversation_id FROM messages WHERE id=?)
		AND (SELECT seq FROM messages WHERE id=?)<=(SELECT seq FROM messages WHERE id=conversations.summary_through)`, d.messageId, d.messageId);
	}

	/** recoverApprovals settles calls whose decision survived but whose result did not. */
	private recoverApprovals() {
		this.db.transaction(() => {
			const unfinished = this.db.all<{ id: string; message_id: string; tool_call_id: string }>(`SELECT a.id,a.message_id,a.tool_call_id FROM approvals a
 JOIN messages m ON m.id=a.message_id, json_each(m.parts) p
 WHERE a.status='approved' AND json_extract(p.value,'$.toolCallId')=a.tool_call_id
 AND json_extract(p.value,'$.state')='approval-responded'`);
			for (const r of unfinished) this.updatePart({ messageId: r.message_id, toolCallId: r.tool_call_id }, p => {
				p.state = 'output-error';
				p.errorText = "The service stopped before this approved call's result was saved. Its outcome is unknown; check before requesting it again.";
			});
		});
	}

	/** expireApprovals marks the conversation's undecided approvals past their expiry as expired and their calls as failed. */
	expireApprovals(conversationID: string) {
		const expired = this.db.transaction(() => {
			const rows = this.db.all<{ id: string; message_id: string; tool_call_id: string }>("SELECT id,message_id,tool_call_id FROM approvals WHERE conversation_id=? AND status='pending' AND expires_at<?", conversationID, Date.now());
			for (const r of rows) {
				this.updatePart({ messageId: r.message_id, toolCallId: r.tool_call_id }, p => { p.state = 'output-error'; p.errorText = expiredApproval; });
				this.db.run("UPDATE approvals SET status='expired' WHERE id=?", r.id);
			}
			return rows.length;
		});
		if (expired) this.changes.conversation(conversationID, false);
	}

	// scheduleExpiry arms the conversation's timer for its earliest pending
	// approval, so clients following changes see expiry without asking.
	private scheduleExpiry(conversationID: string) {
		if (this.closed) return;
		const next = this.db.get<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM approvals WHERE conversation_id=? AND status='pending'", conversationID)?.next;
		const old = this.timers.get(conversationID);
		if (old) { clearTimeout(old); this.timers.delete(conversationID); }
		if (next == null) return;
		const timer = setTimeout(() => {
			this.timers.delete(conversationID);
			if (this.closed) return;
			try { this.expireApprovals(conversationID); this.scheduleExpiry(conversationID); } catch { /* the next snapshot expires it */ }
		}, Math.max(next - Date.now(), 0) + 1);
		(timer as { unref?: () => void }).unref?.();
		this.timers.set(conversationID, timer);
	}

	/** saveFact keeps a fact for the conversation, and for every conversation of the owner's when the owner approved it; id makes saving it again a no-op. */
	saveFact(id: string, conversationID: string, fact: string, owner: boolean) {
		this.db.run('INSERT OR IGNORE INTO memories(id,conversation_id,fact,owner) VALUES(?,?,?,?)', id, conversationID, fact, owner ? 1 : 0);
	}

	/** memories are the facts a turn in conversation id reads: its own, and in the owner's turns every fact the owner approved. */
	memories(id: string, owner: boolean): string[] {
		return this.db.all<{ fact: string }>('SELECT fact FROM memories WHERE conversation_id=? OR (? AND owner) ORDER BY rowid', id, owner ? 1 : 0).map(r => r.fact);
	}

	facts(): Fact[] {
		return this.db.all<{ id: string; conversation_id: string; fact: string; owner: number }>('SELECT id,conversation_id,fact,owner FROM memories ORDER BY rowid').map(r => ({ id: r.id, conversationId: r.conversation_id, text: r.fact, owner: !!r.owner }));
	}

	/** forget deletes the fact with id, or every fact when id is "all", and reports how many it deleted. */
	forget(id: string): number {
		return id === 'all' ? this.db.run('DELETE FROM memories').changes : this.db.run('DELETE FROM memories WHERE id=?', id).changes;
	}

	hasRequest(id: string) { return !!this.db.get('SELECT 1 FROM messages WHERE id=?', id); }

	setting<T>(key: string): T | undefined {
		const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key=?', key);
		return row ? JSON.parse(row.value) as T : undefined;
	}

	saveSetting(key: string, value: unknown) {
		this.db.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
	}

	/** messageChanged publishes a change to the conversation of message id. */
	messageChanged(id: string) {
		if (!this.changes.watched()) return;
		const row = this.db.get<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id=?', id);
		if (row) this.changes.conversation(row.conversation_id, false);
	}

	// Grants: remembered approvals. The owner's calls of tool whose scope is
	// scope run without asking, in the conversation or, when it is empty, in every one.
	addGrant(conversationID: string, tool: string, scope: string) {
		this.db.run('INSERT OR IGNORE INTO grants(id,conversation_id,tool,scope,created_at) VALUES(?,?,?,?,?)', newID(), conversationID, tool, scope, Date.now());
	}
	granted(conversationID: string, tool: string, scope: string) {
		return !!this.db.get("SELECT 1 FROM grants WHERE tool=? AND scope=? AND conversation_id IN ('',?) LIMIT 1", tool, scope, conversationID);
	}
	grants(): Grant[] {
		return this.db.all<{ id: string; conversation_id: string; tool: string; scope: string; created_at: number }>('SELECT id,conversation_id,tool,scope,created_at FROM grants ORDER BY created_at, id').map(r => ({ id: r.id, conversationId: r.conversation_id, tool: r.tool, scope: r.scope, created: r.created_at }));
	}
	revoke(id: string): number {
		return id === 'all' ? this.db.run('DELETE FROM grants').changes : this.db.run('DELETE FROM grants WHERE id=?', id).changes;
	}

	// Usage.
	recordUsage(conversationID: string, messageID: string, model: string, u: ModelUsage, tookMs: number, session = '') {
		this.db.run('INSERT INTO usage(conversation_id,message_id,session,model,input,output,reasoning,cache_read,cache_write,cost,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
			conversationID, messageID, session, model, u.inputTokens, u.outputTokens, u.reasoningTokens ?? 0, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0, u.cost ?? 0, Math.round(tookMs), Date.now());
	}

	/** conversationUsage sums what each of the conversations ids used; conversations that recorded none are left out. */
	conversationUsage(...ids: string[]): Map<string, UsageSummary> {
		const result = new Map<string, UsageSummary>();
		if (!ids.length) return result;
		const inList = '(' + ids.map(() => '?').join(',') + ')';
		for (const row of this.db.all<{ conversation_id: string; model: string } & UsageRow>(`SELECT conversation_id,model,${usageColumns} FROM usage WHERE conversation_id IN ${inList} GROUP BY conversation_id,model`, ...ids)) {
			const m = { model: row.model, ...usageOf(row) };
			const summary = result.get(row.conversation_id) ?? { ...zeroUsage(), turns: 0, models: [] };
			Object.assign(summary, addUsage(summary, m));
			summary.models.push(m);
			result.set(row.conversation_id, summary);
		}
		// A reply may use several models, so turns are counted apart.
		for (const row of this.db.all<{ conversation_id: string; n: number }>(`SELECT conversation_id,COUNT(DISTINCT message_id) AS n FROM usage WHERE conversation_id IN ${inList} GROUP BY conversation_id`, ...ids)) {
			const summary = result.get(row.conversation_id);
			if (!summary) continue;
			summary.turns = row.n;
			summary.models.sort((a, b) => b.totalTokens - a.totalTokens);
		}
		return result;
	}

	/** sessionTotal sums what conversationID recorded for an outside agent's session. */
	sessionTotal(conversationID: string, session: string): ModelUsage {
		const r = this.db.get<{ i: number; o: number; r: number; cr: number; cw: number; c: number }>('SELECT COALESCE(SUM(input),0) AS i,COALESCE(SUM(output),0) AS o,COALESCE(SUM(reasoning),0) AS r,COALESCE(SUM(cache_read),0) AS cr,COALESCE(SUM(cache_write),0) AS cw,COALESCE(SUM(cost),0) AS c FROM usage WHERE conversation_id=? AND session=?', conversationID, session)!;
		return { inputTokens: r.i, outputTokens: r.o, reasoningTokens: r.r, cacheReadTokens: r.cr, cacheWriteTokens: r.cw, cost: r.c };
	}

	/** report sums the usage recorded since since (Unix ms), or all of it when since is 0, keeping the top conversations. */
	report(since: number, top: number): UsageReport {
		const today = localDate(new Date());
		const report: UsageReport = { ...zeroUsage(), turns: 0, models: [], since: 0, firstDay: today, lastDay: today, conversations: 0, days: [], top: [] };
		if (since) { report.since = since; report.firstDay = localDate(new Date(since)); }
		const counts = this.db.get<{ t: number; c: number }>('SELECT COUNT(DISTINCT message_id) AS t,COUNT(DISTINCT conversation_id) AS c FROM usage WHERE created_at>=?', since)!;
		report.turns = counts.t; report.conversations = counts.c;
		for (const row of this.db.all<{ model: string } & UsageRow>(`SELECT model,${usageColumns} FROM usage WHERE created_at>=? GROUP BY model`, since)) {
			const m = { model: row.model, ...usageOf(row) };
			Object.assign(report, addUsage(report, m));
			report.models.push(m);
		}
		report.models.sort((a, b) => b.totalTokens - a.totalTokens);
		for (const row of this.db.all<{ day: string } & UsageRow>(`SELECT date(created_at/1000,'unixepoch','localtime') AS day,${usageColumns} FROM usage WHERE created_at>=? GROUP BY day ORDER BY day`, since)) report.days.push({ date: row.day, ...usageOf(row) });
		if (!since && report.days.length && report.days[0].date < report.firstDay) report.firstDay = report.days[0].date;
		for (const row of this.db.all<{ id: string; title: string; agent: string; turns: number } & UsageRow>(`SELECT u.conversation_id AS id,COALESCE(c.title,'') AS title,COALESCE(t.agent,'') AS agent,${usageColumns.replace(/\((\w+)/g, '(u.$1').replace('u.input+output', 'u.input+u.output')},COUNT(DISTINCT u.message_id) AS turns FROM usage u
 LEFT JOIN conversations c ON c.id=u.conversation_id LEFT JOIN tasks t ON t.conversation_id=u.conversation_id
 WHERE u.created_at>=? GROUP BY u.conversation_id ORDER BY SUM(u.input+u.output) DESC LIMIT ?`, since, top)) {
			const c: TopConversation = { id: row.id, title: row.title, ...usageOf(row), turns: row.turns };
			if (row.agent) c.agent = row.agent;
			report.top.push(c);
		}
		return report;
	}

	// Tasks: work handed to a coding agent, one conversation each.
	createTask(t: Omit<Task, 'id' | 'conversationId' | 'createdAt' | 'updatedAt'>): Task {
		const now = Date.now();
		const task: Task = { ...t, id: newID(), conversationId: newID(), createdAt: now, updatedAt: now };
		this.db.transaction(() => {
			this.db.run('INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)', task.conversationId, title60(task.agent + ': ' + task.title), now);
			this.db.run(`INSERT INTO tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,'','','',?,?)`, task.id, task.conversationId, task.project, task.agent, task.title, task.worktree, task.branch, task.session ?? '', task.status, task.parent ?? '', task.readOnly ? 1 : 0, now, now);
		});
		this.changes.conversation(task.conversationId, true);
		this.changes.tasks();
		return task;
	}
	/** task finds a task by its ID or its conversation's. */
	task(id: string): Task | undefined {
		const row = this.db.get<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE id=? OR conversation_id=?`, id, id);
		return row && taskOf(row);
	}
	/** tasks lists the tasks of project, or of every project when it is empty, most recently updated first. */
	tasks(project = ''): Task[] {
		return this.db.all<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE ?='' OR project=? ORDER BY updated_at DESC,id`, project, project).map(taskOf);
	}
	setTaskStatus(id: string, status: string) { this.db.run('UPDATE tasks SET status=?,updated_at=? WHERE id=?', status, Date.now(), id); this.changes.tasks(); }
	/** stopTasks records every running or waiting task as stopped, for when Mob starts and no agent runs. */
	stopTasks() { this.db.run('UPDATE tasks SET status=? WHERE status IN (?,?)', taskStopped, taskRunning, taskWaiting); this.changes.tasks(); }
	/** say adds what the owner wrote to a conversation whose reply is still being written. */
	say(conversationID: string, text: string) {
		this.db.run("INSERT INTO messages(id,conversation_id,role,parts,status) VALUES(?,?,'user',?,'complete')", newID(), conversationID, JSON.stringify([{ type: 'text', text }]));
		this.changes.conversation(conversationID, false);
	}
	setTaskSession(id: string, session: string) { this.db.run('UPDATE tasks SET session=?,updated_at=? WHERE id=?', session, Date.now(), id); this.changes.tasks(); }
	/** setTaskResult records how task id's agent said its work ended; empty outcome and result forget it, as when the agent is given more work. */
	setTaskResult(id: string, outcome: string, result: string) {
		if (this.db.run('UPDATE tasks SET outcome=?,result=?,updated_at=? WHERE id=? AND (outcome<>? OR result<>?)', outcome, result, Date.now(), id, outcome, result).changes > 0) this.changes.tasks();
	}
	/** note adds Mob's own news to a conversation, such as that the tasks it started ended. Like a command's reply, it is shown but never sent to a model. */
	note(conversationID: string, text: string) {
		this.db.run("INSERT INTO messages(id,conversation_id,role,parts,status,kind) VALUES(?,?,'assistant',?,'complete','command')", newID(), conversationID, JSON.stringify([{ type: 'text', text }]));
		this.db.run('UPDATE conversations SET updated_at=? WHERE id=?', Date.now(), conversationID);
		this.changes.conversation(conversationID, true);
	}
	setTaskPlan(id: string, plan: PlanEntry[]) { this.db.run('UPDATE tasks SET plan=?,updated_at=? WHERE id=?', JSON.stringify(plan), Date.now(), id); this.changes.tasks(); }
	/** lastReply is the last text of the conversation's latest reply. */
	lastReply(conversationID: string) { return this.lastText(this.db.get<{ parts: string }>("SELECT parts FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1", conversationID)); }
	/** reply is the last text of the reply with ID messageID; empty when there is none. */
	reply(messageID: string) { return this.lastText(this.db.get<{ parts: string }>("SELECT parts FROM messages WHERE id=? AND role='assistant'", messageID)); }
	private lastText(row?: { parts: string }) {
		let text = '';
		for (const p of row ? JSON.parse(row.parts) as Part[] : []) if (p.type === 'text') text = typeof p.text === 'string' ? p.text : '';
		return text;
	}
	/** toolsUsed lists the tools a conversation's replies called, by name, in the order they were first called. */
	toolsUsed(conversationID: string): string[] {
		return this.db.all<{ name: string }>(`SELECT substr(json_extract(p.value,'$.type'),6) AS name FROM messages m, json_each(m.parts) p
 WHERE m.conversation_id=? AND m.role='assistant' AND json_extract(p.value,'$.type') LIKE 'tool-%'
 GROUP BY name ORDER BY MIN(m.seq*1000+p.key)`, conversationID).map(r => r.name);
	}

	// Schedules: prompts the model runs on its own later.
	addSchedule(s: Omit<Schedule, 'id' | 'createdAt'>): Schedule {
		const sc: Schedule = { ...s, id: newID(), createdAt: Date.now() };
		this.db.run(`INSERT INTO schedules(${scheduleColumns}) VALUES(?,?,?,?,?,?,?,?)`, sc.id, sc.conversationId, sc.prompt, sc.next, sc.repeat ?? '', sc.zone ?? '', sc.clock ?? '', sc.createdAt);
		return sc;
	}
	/** schedules lists the schedules due by before, or all of them when before is 0, soonest first. */
	schedules(before = 0): Schedule[] {
		return this.db.all<ScheduleRow>(`SELECT ${scheduleColumns} FROM schedules WHERE ?=0 OR next<=? ORDER BY next,id`, before, before).map(scheduleOf);
	}
	reschedule(id: string, next: number) { this.db.run('UPDATE schedules SET next=? WHERE id=?', next, id); }
	unschedule(id: string): number {
		return id === 'all' ? this.db.run('DELETE FROM schedules').changes : this.db.run('DELETE FROM schedules WHERE id=?', id).changes;
	}

	// Deliveries: messages from channels, received exactly once.
	/** acceptDelivery must commit before acknowledging an external update or sending. */
	acceptDelivery(id: string, state: string) { return this.db.run('INSERT OR IGNORE INTO deliveries(id,state,updated_at) VALUES(?,?,?)', id, state, Date.now()).changes === 1; }
	delivery(id: string): Delivery | undefined {
		const r = this.db.get<{ state: string; reply: string; error: string; updated_at: number }>('SELECT state,reply,error,updated_at FROM deliveries WHERE id=?', id);
		return r && { id, state: r.state, reply: r.reply, error: r.error, updatedAt: r.updated_at };
	}
	updateDelivery(id: string, state: string, reply: string, failure?: Error) {
		if (this.db.run('UPDATE deliveries SET state=?,reply=?,error=?,updated_at=? WHERE id=?', state, reply, failure?.message ?? '', Date.now(), id).changes !== 1) throw new NotFound('delivery not found');
	}
	deliveries(): Delivery[] {
		return this.db.all<{ id: string; state: string; reply: string; error: string; updated_at: number }>('SELECT id,state,reply,error,updated_at FROM deliveries ORDER BY updated_at DESC,rowid DESC LIMIT 100').map(r => ({ id: r.id, state: r.state, reply: r.reply, error: r.error, updatedAt: r.updated_at }));
	}
	/** deliveryAccepted: a receipt is durable even when processing or sending fails. */
	deliveryAccepted(id: string) { return !!this.delivery(id); }
}
