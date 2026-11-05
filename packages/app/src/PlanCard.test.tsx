import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlanCard, planInput, type PlanInput } from './PlanCard';
import type { AgentNode } from './contracts';

vi.mock('@mob/ui/voxel/VoxelCanvas', () => ({ VoxelCanvas: () => null }));

afterEach(() => vi.unstubAllGlobals());

const connection = { url: 'http://127.0.0.1:1', token: 't' };
const plan: PlanInput = {
	project: '/src/shop',
	summary: 'Add coupons',
	tasks: [
		{ title: 'API', agent: 'codex', blueprint: 'standard', prompt: 'Add the coupon endpoint' },
		{ title: 'UI', agent: 'claude', blueprint: 'quick', prompt: 'Add the coupon field' },
	],
	blueprints: {
		standard: { does: 'checks, then review', stages: [{ type: 'verify', retries: 2 }, { type: 'review', aspects: ['correctness', 'tests'], rounds: 2 }] },
		quick: { does: 'checks', stages: [{ type: 'verify', retries: 2 }] },
	},
};
const waiting = { kind: 'waiting', label: 'Waiting for your approval', icon: null };

it('shows each task with the steps its blueprint runs, and the flow on demand', () => {
	render(
		<PlanCard connection={connection} input={plan} state={waiting} open={() => {}} approval={{ busy: false, decide: () => {} }} />,
	);
	const card = screen.getByRole('region', { name: 'Plan' });
	expect(within(card).getByText('Plan · 2 tasks in shop')).toBeTruthy();
	expect(within(card).getByText('Add coupons')).toBeTruthy();
	expect(within(card).getByText('codex · checks, then review')).toBeTruthy();
	expect(within(card).getByText('claude · checks only')).toBeTruthy();
	expect(within(card).getAllByText('Review')).toHaveLength(1);
	// Instructions wait a click further, in the flow.
	expect(screen.queryByText('Add the coupon field')).toBeNull();
	fireEvent.click(within(card).getByRole('button', { name: /UI/ }));
	const flow = screen.getByRole('dialog');
	// The step the row opened says what it does, and its instructions are one click further.
	const step = within(flow).getByRole('complementary', { name: 'Step' });
	expect(within(step).getByText(/claude works on “UI” in its own worktree and branch of shop/)).toBeTruthy();
	expect(within(step).getByDisplayValue('Add the coupon field')).toBeTruthy();
	fireEvent.click(within(flow).getAllByRole('button', { name: /Review/ })[0]);
	expect(within(step).getByText(/reviews correctness and tests/)).toBeTruthy();
	expect(within(flow).getByText('rework → back · ≤ 2 rounds')).toBeTruthy();
	expect(within(flow).getAllByText('fails → back · ≤ 2×')).toHaveLength(2);
	// Shipping stays yours.
	fireEvent.click(within(flow).getByRole('button', { name: /Ship/ }));
	expect(within(step).getByText('Always asks you')).toBeTruthy();
	// The decision is in the flow too.
	expect(within(flow).getByRole('button', { name: 'Allow once' })).toBeTruthy();
});

it('shows where each started task is, and opens it', async () => {
	const node = (conversationId: string, status: string, flow?: object): AgentNode =>
		({ conversationId, agent: 'codex', label: 'Codex', title: 'x', status, approvals: [], tools: [], task: { flow } }) as unknown as AgentNode;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json([node('c1', 'review', { blueprint: 'standard', stage: 'review', round: 2, tries: 0 }), node('c2', 'running'), node('other', 'running')])),
	);
	const open = vi.fn();
	render(
		<PlanCard
			connection={connection}
			input={plan}
			output={{
				tasks: [
					{ index: 0, task: 't1', conversation: 'c1', title: 'API', agent: 'codex', branch: 'mob/api-1' },
					{ index: 1, task: 't2', conversation: 'c2', title: 'UI', agent: 'claude', branch: 'mob/ui-2' },
				],
			}}
			state={{ kind: 'done', label: 'Done', icon: null }}
			open={open}
		/>,
	);
	fireEvent.click(await screen.findByRole('button', { name: /In review/ }));
	expect(open).toHaveBeenCalledWith('c1');
	expect(screen.getByRole('button', { name: /Running/ })).toBeTruthy();
	expect(screen.getByText('claude · checks only · mob/ui-2')).toBeTruthy();
	// In the flow, the review step says which round it is on, and opens the task.
	fireEvent.click(screen.getByRole('button', { name: 'Open as flow' }));
	const flow = screen.getByRole('dialog');
	fireEvent.click(within(flow).getAllByRole('button', { name: /Review/ })[0]);
	const step = within(flow).getByRole('complementary', { name: 'Step' });
	expect(within(step).getByText('Round 2')).toBeTruthy();
	fireEvent.click(within(step).getByRole('button', { name: 'Open its conversation' }));
	expect(open).toHaveBeenCalledTimes(2);
});

it('shows each start against its own task when titles repeat and one failed to start', () => {
	const twice: PlanInput = { ...plan, tasks: [{ title: 'Tests', agent: 'codex', blueprint: 'standard', prompt: 'one' }, { title: 'Tests', agent: 'codex', blueprint: 'quick', prompt: 'two' }] };
	vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
	const open = vi.fn();
	render(
		<PlanCard
			connection={connection}
			input={twice}
			output={{ tasks: [{ index: 1, task: 't2', conversation: 'c2', title: 'Tests', agent: 'codex', branch: 'mob/tests-2' }], failed: ['Tests: no worktree'] }}
			state={{ kind: 'done', label: 'Done', icon: null }}
			open={open}
		/>,
	);
	const [first, second] = screen.getAllByRole('listitem');
	expect(within(first).queryByRole('button', { name: /Started/ })).toBeNull();
	expect(within(second).getByText('codex · checks only · mob/tests-2')).toBeTruthy();
	fireEvent.click(within(second).getByRole('button', { name: /Started/ }));
	expect(open).toHaveBeenCalledWith('c2');
});

it('reads only what a plan call holds that the card can show', () => {
	expect(planInput(undefined)).toEqual({});
	expect(planInput('bad')).toBeUndefined();
	expect(planInput({ tasks: 'bad' })).toBeUndefined();
	expect(planInput({ tasks: [null] })).toBeUndefined();
	expect(planInput({ tasks: [{ title: 3, prompt: 'x' }], blueprints: { a: { does: 'x', stages: 'no' }, b: 'checks' } })).toEqual({
		tasks: [{ title: undefined, agent: undefined, blueprint: undefined, prompt: 'x' }],
		blueprints: {},
	});
});

it('approves the plan with what the owner changed in its steps', () => {
	const decide = vi.fn();
	render(<PlanCard connection={connection} input={plan} state={waiting} open={() => {}} approval={{ busy: false, decide }} />);
	fireEvent.click(screen.getByRole('button', { name: /API/ }));
	const flow = screen.getByRole('dialog');
	const step = within(flow).getByRole('complementary', { name: 'Step' });
	// The API task: shorter instructions, one more retry, and a review of security too, in one round.
	fireEvent.change(within(step).getByLabelText('Instructions'), { target: { value: 'Add the coupon endpoint, with tests' } });
	fireEvent.click(within(flow).getAllByRole('button', { name: /Checks/ })[0]);
	fireEvent.click(within(step).getByRole('button', { name: 'More retries' }));
	expect(within(step).getByText('3')).toBeTruthy();
	expect(within(step).getByRole('button', { name: 'More retries' })).toHaveProperty('disabled', true);
	fireEvent.click(within(flow).getAllByRole('button', { name: /Review/ })[0]);
	fireEvent.click(within(step).getByRole('button', { name: 'security' }));
	fireEvent.click(within(step).getByRole('button', { name: 'Fewer rounds' }));
	// The UI task: a review added after its checks.
	fireEvent.click(within(flow).getAllByRole('button', { name: /Ready to review/ })[1]);
	fireEvent.click(within(step).getByRole('button', { name: /Add a review/ }));
	expect(within(flow).getAllByText('rework → back · ≤ 1 round')).toHaveLength(2);
	fireEvent.click(within(flow).getAllByRole('button', { name: 'Approve with 4 changes' })[0]);
	expect(decide).toHaveBeenCalledWith(true, undefined, undefined, {
		tasks: [
			{
				prompt: 'Add the coupon endpoint, with tests',
				stages: [
					{ type: 'verify', retries: 3 },
					{ type: 'review', aspects: ['correctness', 'tests', 'security'], rounds: 1 },
				],
			},
			{ stages: [{ type: 'verify', retries: 2 }, { type: 'review', aspects: ['correctness', 'tests'], rounds: 1 }] },
		],
	});
	// Undoing the changes approves the plan as Mob asked.
	fireEvent.click(within(flow).getByRole('button', { name: 'Undo changes' }));
	fireEvent.click(within(flow).getByRole('button', { name: 'Allow once' }));
	expect(decide).toHaveBeenLastCalledWith(true, undefined, undefined, undefined);
});

it('draws a task with the stages the owner set for it', () => {
	render(<PlanCard connection={connection} input={{ ...plan, tasks: [{ ...plan.tasks![1], stages: [{ type: 'verify', retries: 1 }, { type: 'review', aspects: ['docs'], rounds: 1 }] }] }} state={waiting} open={() => {}} />);
	expect(screen.getByText('claude · checks, then review')).toBeTruthy();
});

it('draws the plan as a studio, whose desks open their task in the flow', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
	render(<PlanCard connection={connection} input={plan} state={waiting} open={() => {}} approval={{ busy: false, decide: () => {} }} />);
	fireEvent.click(screen.getByRole('button', { name: 'Open as flow' }));
	const flow = screen.getByRole('dialog');
	fireEvent.click(within(flow).getByRole('button', { name: 'Studio' }));
	expect(within(flow).queryByRole('complementary', { name: 'Step' })).toBeNull();
	// The studio is laid out once it knows its size.
	const desk = await within(flow).findByRole('button', { name: '2. UI: Waiting for your approval. Show its steps' });
	expect(within(flow).getByText('Review')).toBeTruthy();
	fireEvent.click(desk);
	expect(within(within(flow).getByRole('complementary', { name: 'Step' })).getByDisplayValue('Add the coupon field')).toBeTruthy();
	// The decision stays at the foot of either view.
	expect(within(flow).getByRole('button', { name: 'Allow once' })).toBeTruthy();
});
