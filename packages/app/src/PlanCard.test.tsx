import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlanCard, type PlanInput } from './PlanCard';
import type { AgentNode } from './contracts';

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
		<PlanCard connection={connection} input={plan} state={waiting} open={() => {}}>
			<button type="button">Allow once</button>
		</PlanCard>,
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
	expect(within(step).getByText('Add the coupon field')).toBeTruthy();
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
					{ task: 't1', conversation: 'c1', title: 'API', agent: 'codex', branch: 'mob/api-1' },
					{ task: 't2', conversation: 'c2', title: 'UI', agent: 'claude', branch: 'mob/ui-2' },
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

it('still shows plans asked before blueprints listed their stages', () => {
	render(<PlanCard connection={connection} input={{ ...plan, blueprints: { standard: 'checks, then review', quick: 'checks' } }} state={waiting} open={() => {}} />);
	fireEvent.click(screen.getByRole('button', { name: /API/ }));
	fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: /Ready/ })[0]);
	expect(screen.getByText('The task follows its blueprint: checks, then review.')).toBeTruthy();
});
