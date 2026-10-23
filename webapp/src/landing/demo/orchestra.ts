// The orchestration demo: Mob splits a goal into tasks, hands them to coding
// agents on their own branches, and those start agents of their own. One
// task waits for an approval, one fails and Mob tries again with another
// agent, and Mob checks every branch before it reports back. Times are in
// seconds of the replay; a task after the approval counts from the moment
// it was decided.

export type Agent = 'mob' | 'codex' | 'claude' | 'dsh';
export type Status = 'running' | 'waiting' | 'review' | 'failed' | 'stopped' | 'idle';
export type Tool = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think';
type Line = { at: number; text: string; after?: 'allow' | 'deny' };

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
			{ at: 10, text: 'tests-t5 failed; asked Claude Agent for a fix' },
		],
	},
	{
		id: 't1', parent: 'mob', agent: 'codex', label: 'Codex', model: 'gpt-5.5-codex', title: 'Fix the flaky checkout test', branch: 'mob/flaky-t1',
		steps: 3, tools: ['read', 'edit', 'execute'], cost: 0.19, tokens: 141_000, start: 1.5, end: Infinity, diff: '+14 −6 · checkout/clock.go, total_test.go',
		waits: { at: 6.2, step: 2, tool: 'Run command · in the sandbox', text: '$ go test ./checkout/... -count=50 -race', then: 2.8 },
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
		steps: 4, tools: ['read', 'edit', 'execute'], cost: 0.24, tokens: 164_000, start: 2.3, end: 16.5, diff: '+96 −11 · 4 files',
		log: [{ at: 1, text: 'Wrapped Charge in a retry with backoff' }, { at: 3.6, text: 'Started DeepSeek on the retry tests' }, { at: 12.4, text: 'Merged the fix into retry-t2' }],
	},
	{
		id: 't5', parent: 't2', agent: 'dsh', label: 'DeepSeek', model: 'deepseek-v4-pro', title: 'Write tests for the retry policy', branch: 'mob/tests-t5',
		steps: 2, tools: ['edit', 'execute'], cost: 0.03, tokens: 41_000, start: 6, end: 9.8, failed: true,
		log: [{ at: 0.5, text: 'Wrote 9 tests' }, { at: 1.6, text: '$ go test ./payments/...' }, { at: 3.7, text: 'FAIL: 1 of 9, a declined card was retried' }],
	},
	{
		id: 't7', parent: 't2', agent: 'claude', label: 'Claude Agent', model: 'claude-sonnet-5-5', title: 'Never retry a declined card', branch: 'mob/fix-t7',
		steps: 2, tools: ['edit', 'execute'], cost: 0.05, tokens: 38_000, start: 10.4, end: 14.2, diff: '+9 −4 · payments/retry.go',
		log: [{ at: 0.5, text: 'Retry only timeouts and 5xx answers' }, { at: 3.4, text: '$ go test ./payments/... ok, 9 passed' }],
	},
];

export type Decision = 'allow' | 'always' | 'deny';
export type Run = { t: number; decided?: number; decision?: Decision; stopped: Record<string, number> };

export const begin = (): Run => ({ t: 0, stopped: {} });

const byId = new Map(tasks.map(t => [t.id, t]));
const ancestors = (task: Task): Task[] => task.parent ? [byId.get(task.parent)!, ...ancestors(byId.get(task.parent)!)] : [];
// A task stops when it, or any agent above it, was stopped.
const stoppedAt = (run: Run, task: Task) => Math.min(...[task, ...ancestors(task)].map(t => run.stopped[t.id] ?? Infinity));

/** finished is when a task is over, Infinity while it waits on someone. */
function finished(run: Run, task: Task): number {
	const end = task.waits ? (run.decided === undefined ? Infinity : run.decided + task.waits.then) : task.end;
	return Math.min(end, stoppedAt(run, task));
}
const others = tasks.filter(t => t.id !== 'mob');
/** reported is when Mob has checked every branch and answered. */
export const reported = (run: Run) => Math.max(...others.map(t => finished(run, t))) + CHECK;

export type View = { task: Task; status: Status; done: number; cost: number; tokens: number; seconds: number; log: string[]; checking?: boolean; asking: boolean };

export function view(run: Run, task: Task): View | undefined {
	const { t } = run;
	if (t < task.start) return undefined;
	if (task.id === 'mob') {
		const end = reported(run);
		const fraction = t >= end ? 1 : Math.min(0.9, t / 20);
		const log = task.log.filter(l => l.at <= t).map(l => l.text);
		const checking = t >= end - CHECK && t < end;
		if (checking) log.push('Checking every branch: task_diff, task_check');
		if (t >= end) log.push('task_check: tests pass on every branch', run.decision === 'deny' ? 'Reported back: retry-t2 ready, flaky-t1 waits for your test run' : 'Reported back: both branches ready to merge');
		return { task, status: t >= end ? 'idle' : 'running', done: Math.round(fraction * task.steps), cost: task.cost * fraction, tokens: task.tokens * fraction, seconds: Math.min(t, end), log, checking, asking: false };
	}
	const end = finished(run, task);
	const stopped = stoppedAt(run, task) <= t;
	const asking = !!task.waits && t >= task.waits.at && run.decided === undefined && !stopped;
	const status: Status = stopped ? 'stopped' : asking ? 'waiting' : t >= end ? (task.failed ? 'failed' : 'review') : 'running';
	const until = Math.min(t, end);
	const length = task.waits ? task.waits.at - task.start + task.waits.then : task.end - task.start;
	const spent = task.waits && run.decided !== undefined ? (task.waits.at - task.start) + (until - run.decided) : Math.min(until, task.waits?.at ?? Infinity) - task.start;
	const fraction = status === 'review' ? 1 : Math.min(0.95, Math.max(0, spent / length));
	const log = task.log
		.filter(l => l.after ? run.decision !== undefined && (l.after === 'deny') === (run.decision === 'deny') && run.decided! + l.at <= t : task.start + l.at <= t)
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
