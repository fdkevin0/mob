// The demo: you ask once, Mob splits the goal into tasks, hands them to
// coding agents on their own branches, and those start agents of their own. One
// task waits for an approval, one fails and Mob tries again with another
// agent, and Mob checks every branch before it reports back. Times are in
// seconds of the replay; a task after the approval counts from the moment
// it was decided.

export type Agent = 'mob' | 'codex' | 'claude' | 'dsh';
export type Status = 'running' | 'waiting' | 'review' | 'failed' | 'stopped' | 'idle';
export type Tool = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think';
// after ties a line to the answer; failed shows it only if that task failed.
type Line = { at: number; text: string; after?: 'allow' | 'deny'; failed?: string };

export type Task = {
	id: string;
	parent?: string;
	agent: Agent;
	label: string;
	model: string;
	title: string;
	branch?: string;
	steps: number;
	tools: Tool[];
	cost: number;
	tokens: number;
	start: number;
	end: number;
	failed?: boolean;
	/** retries names a failed task this one picks up; it runs only if that one failed. */
	retries?: string;
	/** result is what the task reports when it is ready. */
	result?: string;
	/** waits is when the task stops to ask; it ends this long after the answer. */
	waits?: { at: number; step: number; tool: string; text: string; then: number };
	diff?: string;
	log: Line[];
};

export const goal = 'Fix the flaky checkout test in shop-api and add retries to the payment client';
export const project = 'shop-api';
const CHECK = 3; // how long Mob checks the branches before it reports

export const tasks: Task[] = [
	{
		id: 'mob', agent: 'mob', label: 'Mob', model: 'claude-sonnet-5-5', title: goal, steps: 4, tools: ['think'], cost: 0.021, tokens: 19_000, start: 0, end: 0,
		log: [
			{ at: 0.3, text: 'Planned 2 tasks: the flaky test, the retries' },
			{ at: 1.5, text: 'Started Codex on flaky-t1' },
			{ at: 2.3, text: 'Started Claude Agent on retry-t2' },
			{ at: 10, text: 'tests-t5 failed; asked Claude Agent for a fix', failed: 't5' },
		],
	},
	{
		id: 't1', parent: 'mob', agent: 'codex', label: 'Codex', model: 'gpt-5.5-codex', title: 'Fix the flaky checkout test', branch: 'mob/flaky-t1',
		steps: 3, tools: ['read', 'edit', 'execute'], cost: 0.19, tokens: 141_000, start: 1.5, end: Infinity, diff: '+14 −6 · checkout/clock.go, total_test.go', result: '50 of 50 runs pass',
		waits: { at: 6.2, step: 2, tool: 'codex_execute', text: '$ go test ./checkout/... -count=50 -race', then: 2.8 },
		log: [
			{ at: 0.5, text: 'Started Claude Agent on the CI history' },
			{ at: 3.6, text: 'Found it: the test reads the wall clock' },
			{ at: 4.7, text: 'Asked to run the tests 50 times' },
			{ at: 2.4, text: '50 of 50 runs passed with -race', after: 'allow' },
			{ at: 0.3, text: 'Skipped the run; left a note to run it yourself', after: 'deny' },
		],
	},
	{
		id: 't3', parent: 't1', agent: 'claude', label: 'Claude Agent', model: 'claude-sonnet-5-5', title: 'Find why TestCheckoutTotal fails one run in twenty', branch: 'mob/ci-t3',
		steps: 2, tools: ['read', 'think'], cost: 0.06, tokens: 72_000, start: 2.4, end: 5.6,
		log: [{ at: 0.4, text: 'Read 200 CI runs' }, { at: 2.8, text: 'It fails only across midnight UTC' }],
	},
	{
		id: 't2', parent: 'mob', agent: 'claude', label: 'Claude Agent', model: 'claude-opus-5-5', title: 'Add retries to the payment client', branch: 'mob/retry-t2',
		steps: 4, tools: ['read', 'edit', 'execute'], cost: 0.24, tokens: 164_000, start: 2.3, end: 16.5, diff: '+96 −11 · 4 files', result: 'Retries timeouts, not declines',
		log: [{ at: 1, text: 'Wrapped Charge in a retry with backoff' }, { at: 3.6, text: 'Started DeepSeek on the retry tests' }, { at: 12.4, text: 'Merged the fix into retry-t2', failed: 't5' }],
	},
	{
		id: 't5', parent: 't2', agent: 'dsh', label: 'DeepSeek', model: 'deepseek-v4-pro', title: 'Write tests for the retry policy', branch: 'mob/tests-t5',
		steps: 2, tools: ['edit', 'execute'], cost: 0.03, tokens: 41_000, start: 6, end: 9.8, failed: true,
		log: [{ at: 0.5, text: 'Wrote 9 tests' }, { at: 1.6, text: '$ go test ./payments/...' }, { at: 3.7, text: 'FAIL: 1 of 9, a declined card was retried' }],
	},
	{
		id: 't7', parent: 't2', agent: 'claude', label: 'Claude Agent', model: 'claude-sonnet-5-5', title: 'Never retry a declined card', branch: 'mob/fix-t7',
		steps: 2, tools: ['edit', 'execute'], cost: 0.05, tokens: 38_000, start: 10.4, end: 14.2, retries: 't5', diff: '+9 −4 · payments/retry.go',
		log: [{ at: 0.5, text: 'Retry only timeouts and 5xx answers' }, { at: 3.4, text: '$ go test ./payments/... ok, 9 passed' }],
	},
];

export type Decision = 'allow' | 'always' | 'deny';
export type Run = { t: number; decided?: number; decision?: Decision; stopped: Record<string, number> };

/** COMPOSE is how long the prompt takes to type before it is sent at 0. */
export const COMPOSE = 2.6;
export const begin = (): Run => ({ t: -COMPOSE, stopped: {} });
/** typed is how much of the goal is in the composer. */
export const typed = (run: Run) => run.t >= 0 ? goal.length : Math.max(0, Math.round(((run.t + COMPOSE) / (COMPOSE - 0.5)) * goal.length));

const byId = new Map(tasks.map(t => [t.id, t]));
const ancestors = (task: Task): Task[] => task.parent ? [byId.get(task.parent)!, ...ancestors(byId.get(task.parent)!)] : [];
// A task stops when it, or any agent above it, was stopped.
const stoppedAt = (run: Run, task: Task) => Math.min(...[task, ...ancestors(task)].map(t => run.stopped[t.id] ?? Infinity));

const descendants = (task: Task): Task[] => tasks.filter(t => t.parent === task.id).flatMap(t => [t, ...descendants(t)]);

/** natural is when a task would be over if nobody stopped it, Infinity while it waits on someone. */
const natural = (run: Run, task: Task) => task.waits ? (run.decided === undefined ? Infinity : run.decided + task.waits.then) : task.end;
/** cut: stopped before it was over. */
const cut = (run: Run, task: Task) => stoppedAt(run, task) < natural(run, task);
/** skipped: never ran, because it was stopped first or there was nothing to retry. */
function skipped(run: Run, task: Task): boolean {
	if (stoppedAt(run, task) < task.start) return true;
	const retried = task.retries ? byId.get(task.retries)! : undefined;
	return !!retried && !failed(run, retried);
}
const failed = (run: Run, task: Task) => !!task.failed && !skipped(run, task) && !cut(run, task);

/** finished is when a task is over, Infinity while it waits on someone. */
function finished(run: Run, task: Task): number {
	return skipped(run, task) ? -Infinity : Math.min(natural(run, task), stoppedAt(run, task));
}
const others = tasks.filter(t => t.id !== 'mob');
/** reported is when Mob has checked every branch and answered. */
export const reported = (run: Run) => Math.max(...others.map(t => finished(run, t))) + CHECK;

// What became of each branch Mob handed out: ready, run without the check
// you denied, stopped by you, or with part of its work stopped.
export type Outcome = 'ready' | 'unchecked' | 'stopped' | 'partial';
export function outcome(run: Run, task: Task): Outcome {
	if (cut(run, task)) return 'stopped';
	if (descendants(task).some(d => !skipped(run, d) && cut(run, d))) return 'partial';
	if (task.waits && run.decision === 'deny') return 'unchecked';
	return 'ready';
}

export const branches = tasks.filter(t => t.parent === 'mob');
const plain = (s: string) => s.replace(/`/g, '');

/** report is what Mob says back, worked out from what became of each branch. */
export function report(run: Run, cost: number) {
	const rows = branches.map(task => ({ task, outcome: outcome(run, task) }));
	const ready = rows.filter(r => r.outcome === 'ready');
	const left = rows.filter(r => r.outcome !== 'ready').map(({ task, outcome }) =>
		outcome === 'stopped' ? `You stopped \`${task.branch}\`; it stays as it was.`
		: outcome === 'partial' ? `You stopped part of \`${task.branch}\`, so I didn't check it.`
		: `You skipped the 50-run check, so run it before you merge \`${task.branch}\`.`);
	const all = ready.length === rows.length;
	const head = all ? 'Both are ready to merge, and **task_check** passes on each branch.'
		: ready.length ? `${ready.map(r => `\`${r.task.branch}\``).join(', ')} is ready to merge, and **task_check** passes on it.`
		: 'Nothing is ready to merge.';
	const agents = tasks.filter(t => !skipped(run, t)).length;
	const banner = all ? 'Both branches are ready to merge' : `${ready.length} of ${rows.length} branches ready to merge`;
	const ask = ready.length > 1 ? 'Want me to open the pull requests?' : ready.length ? 'Want me to open the pull request?' : 'Tell me when to pick it up again.';
	return {
		ready: ready.length, banner,
		results: rows.map(({ task, outcome }) => outcome === 'ready' ? task.result! : outcome === 'stopped' ? 'Stopped by you' : outcome === 'partial' ? 'Partly stopped, not checked' : 'Fixed, not run 50 times'),
		lead: [head, ...left].join(' '),
		closing: `${agents} agents in all, **${money(cost)}** and ${clock(reported(run))}. ${ask}`,
		brief: `Done. ${plain([all ? 'Both branches are ready to merge and the checks pass.' : head.replace(/, and \*\*task_check\*\* passes on it\./, '.'), ...left].join(' '))} ${agents} agents, ${money(cost)}, ${clock(reported(run))}.`,
		log: [
			...(ready.length ? [`task_check: tests pass on ${all ? 'every branch' : ready.map(r => r.task.branch).join(', ')}`] : []),
			`Reported back: ${banner.toLowerCase()}`,
		],
	};
}

export type View = { task: Task; status: Status; done: number; cost: number; tokens: number; seconds: number; log: string[]; checking?: boolean; asking: boolean };

export function view(run: Run, task: Task): View | undefined {
	const { t } = run;
	if (t < task.start) return undefined;
	if (task.id === 'mob') {
		const end = reported(run);
		const fraction = t >= end ? 1 : Math.min(0.9, t / 20);
		const log = task.log.filter(l => l.at <= t && (!l.failed || failed(run, byId.get(l.failed)!))).map(l => l.text);
		const checking = t >= end - CHECK && t < end;
		if (checking) log.push('Checking the branches: task_diff, task_check');
		if (t >= end) log.push(...report(run, 0).log);
		return { task, status: t >= end ? 'idle' : 'running', done: Math.round(fraction * task.steps), cost: task.cost * fraction, tokens: task.tokens * fraction, seconds: Math.min(t, end), log, checking, asking: false };
	}
	if (skipped(run, task)) return undefined;
	const end = finished(run, task);
	// Stopping an agent leaves the work already done under it as it was.
	const stopped = cut(run, task) && stoppedAt(run, task) <= t;
	// A stopped task's script ends where it was stopped.
	const upTo = Math.min(t, stoppedAt(run, task));
	const asking = !!task.waits && t >= task.waits.at && run.decided === undefined && !stopped;
	const status: Status = stopped ? 'stopped' : asking ? 'waiting' : t >= end ? (task.failed ? 'failed' : 'review') : 'running';
	const until = Math.min(t, end);
	const length = task.waits ? task.waits.at - task.start + task.waits.then : task.end - task.start;
	const spent = task.waits && run.decided !== undefined ? (task.waits.at - task.start) + (until - run.decided) : Math.min(until, task.waits?.at ?? Infinity) - task.start;
	const fraction = status === 'review' ? 1 : Math.min(0.95, Math.max(0, spent / length));
	const log = task.log
		.filter(l => !l.failed || failed(run, byId.get(l.failed)!))
		.filter(l => l.after ? run.decision !== undefined && (l.after === 'deny') === (run.decision === 'deny') && run.decided! + l.at <= upTo : task.start + l.at <= upTo)
		.map(l => l.text);
	if (stopped) log.push('Stopped by you; its branch stays');
	return {
		task, status, asking,
		done: status === 'review' ? task.steps : asking ? task.waits!.step : Math.floor(fraction * task.steps),
		cost: task.cost * fraction, tokens: task.tokens * fraction,
		seconds: until - task.start, log,
	};
}

export function decide(run: Run, decision: Decision): Run {
	const t2 = tasks.find(t => t.waits)!;
	if (run.decided !== undefined || run.t < t2.waits!.at) return run;
	return { ...run, decided: run.t, decision };
}

export function stop(run: Run, id: string): Run {
	if (run.stopped[id] !== undefined) return run;
	return { ...run, stopped: { ...run.stopped, [id]: run.t } };
}

export const waitingFor = (run: Run) => tasks.find(t => t.waits && view(run, t)?.asking);

/** finish plays the whole run, approving when asked, for reduced motion. */
export function finish(): Run {
	const t2 = tasks.find(t => t.waits)!;
	const run = { ...begin(), t: t2.waits!.at + 1.5 };
	const decided = decide(run, 'allow');
	return { ...decided, t: reported(decided) };
}

// A replay second stands for about ten real ones.
export const clock = (seconds: number) => {
	const s = Math.round(seconds * 10);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const money = (n: number) => `$${n.toFixed(3)}`;
export const count = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`;
