// The sample plan the documentation's prototype shows (docs/features/plans.md),
// and how its tasks would move once approved: the replies the workspace would
// get from Mob's /tasks, worked out from the seconds since approval.
import type { PlanInput } from '@mob/app/PlanCard';

type Stage = NonNullable<NonNullable<PlanInput['tasks']>[number]['stages']>[number];

export const plan: PlanInput = {
	project: '/src/shop-api',
	summary: 'Add discount coupons: the API, the checkout field, and the docs.',
	tasks: [
		{ title: 'Coupon API', agent: 'codex', blueprint: 'standard', prompt: 'Add POST /coupons and apply coupons at checkout.\nValidate expiry and usage limits; add tests.' },
		{ title: 'Checkout coupon field', agent: 'claude', blueprint: 'standard', prompt: 'Add a coupon field to the checkout form, with its error states.' },
		{ title: 'Document coupons', agent: 'claude', blueprint: 'quick', prompt: 'Document the coupon API in docs/api.md.' },
	],
	blueprints: {
		standard: { does: 'checks, then review', stages: [{ type: 'verify', retries: 2 }, { type: 'review', aspects: ['correctness', 'tests'], rounds: 2 }] },
		quick: { does: 'checks', stages: [{ type: 'verify', retries: 2 }] },
	},
};

const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
const branches = ['mob/coupon-api', 'mob/checkout-coupon', 'mob/coupon-docs'];

// output is what task_plan returns once the plan starts.
export const output = {
	tasks: plan.tasks!.map((t, index) => ({ index, task: `t${index + 1}`, conversation: `c${index + 1}`, title: t.title, agent: t.agent, branch: branches[index] })),
};

// stagesOf is what a task runs: the stages the owner set in the approval, or its blueprint's.
export function stagesOf(index: number, changed?: unknown): Stage[] {
	const own = (changed as { tasks?: { stages?: Stage[] }[] } | undefined)?.tasks?.[index]?.stages;
	const b = plan.blueprints?.[plan.tasks![index].blueprint ?? ''];
	return own ?? (typeof b === 'object' ? (b.stages ?? []) : []);
}

type Phase = { status: string; stage: string; round?: number; tries?: number; passed?: boolean };

// phases is a task's run, a few seconds a step: the agent builds, the checks
// run (the checkout field fails once and goes back to its agent), a review
// round finds nothing, and it is ready.
export function phases(index: number, stages: Stage[]): [number, Phase][] {
	const out: [number, Phase][] = [];
	let t = index * 1.5;
	const at = (seconds: number, p: Phase) => {
		out.push([t, p]);
		t += seconds;
	};
	at(4, { status: 'running', stage: 'build' });
	const verify = stages.find((s) => s.type === 'verify');
	if (verify) {
		if (index === 1 && (verify.retries ?? 0) > 0) {
			at(2.5, { status: 'review', stage: 'verify', passed: false });
			at(4, { status: 'running', stage: 'build', tries: 1, passed: false });
		}
		at(2.5, { status: 'review', stage: 'verify', tries: index === 1 && (verify.retries ?? 0) > 0 ? 1 : 0 });
	}
	const review = stages.find((s) => s.type === 'review');
	if (review) at(4, { status: 'review', stage: 'review', round: 1, passed: true });
	at(0, { status: 'review', stage: 'ready', passed: true });
	return out;
}

type Node = { conversationId: string; status: string; task: { branch: string; flow: { stage: string; tries: number; stages: Stage[] } } };

// nodes are the started tasks as the agent tree lists them, `seconds` after approval.
export function nodes(seconds: number, changed?: unknown): Node[] {
	return plan.tasks!.map((task, index) => {
		const stages = stagesOf(index, changed);
		const run = phases(index, stages);
		const [, p] = [...run].reverse().find(([at]) => at <= seconds) ?? run[0];
		const checks = p.passed === undefined ? undefined : [{ command: 'bun test', passed: p.passed, exitCode: p.passed ? 0 : 1, seconds: 3 }];
		return {
			conversationId: `c${index + 1}`,
			agent: task.agent,
			label: labels[task.agent ?? ''] ?? task.agent,
			title: task.title,
			status: p.status,
			approvals: [],
			tools: [],
			task: {
				branch: branches[index],
				flow: { blueprint: task.blueprint, stages, stage: p.stage, round: p.round ?? 1, tries: p.tries ?? 0, checks, review: p.stage === 'ready' && stages.some((s) => s.type === 'review') ? 'No findings that hold up.' : undefined },
			},
		};
	});
}

// approved is the plan as Mob carries it out: with the owner's changes, as
// task_plan's revise writes them back to the call.
export function approved(changed?: unknown): PlanInput {
	const tasks = (changed as { tasks?: { prompt?: string; stages?: Stage[] }[] } | undefined)?.tasks;
	if (!tasks) return plan;
	return { ...plan, tasks: plan.tasks!.map((t, i) => ({ ...t, ...tasks[i] })) };
}

// done is when every task is ready.
export const done = (changed?: unknown) => Math.max(...plan.tasks!.map((_, i) => phases(i, stagesOf(i, changed)).at(-1)![0]));
