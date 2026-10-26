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
	blueprints: { standard: 'checks, then review', quick: 'checks' },
};
const waiting = { kind: 'waiting', label: 'Waiting for your approval', icon: null };

it('shows the tasks a plan would start, and what their blueprints do', () => {
	render(
		<PlanCard connection={connection} input={plan} state={waiting} open={() => {}}>
			<button type="button">Allow once</button>
		</PlanCard>,
	);
	const card = screen.getByRole('region', { name: 'Plan' });
	expect(within(card).getByText('Plan · 2 tasks in shop')).toBeTruthy();
	expect(within(card).getByText('Add coupons')).toBeTruthy();
	expect(within(card).getByText('codex · standard blueprint')).toBeTruthy();
	expect(within(card).getByText('Add the coupon field')).toBeTruthy();
	expect(within(card).getByText(/checks, then review/)).toBeTruthy();
	expect(within(card).getByRole('button', { name: 'Allow once' })).toBeTruthy();
});

it('shows where each started task is, and opens it', async () => {
	const node = (conversationId: string, status: string, flow?: object): AgentNode =>
		({ conversationId, agent: 'codex', label: 'Codex', title: 'x', status, approvals: [], tools: [], task: { flow } }) as unknown as AgentNode;
	vi.stubGlobal('fetch', vi.fn(async () => Response.json([node('c1', 'review', { blueprint: 'standard', stage: 'ready', round: 1, tries: 0 }), node('c2', 'running'), node('other', 'running')])));
	const open = vi.fn();
	render(
		<PlanCard
			connection={connection}
			input={plan}
			output={{ tasks: [{ task: 't1', conversation: 'c1', title: 'API', agent: 'codex', branch: 'mob/api-1' }, { task: 't2', conversation: 'c2', title: 'UI', agent: 'claude', branch: 'mob/ui-2' }] }}
			state={{ kind: 'done', label: 'Done', icon: null }}
			open={open}
		/>,
	);
	fireEvent.click(await screen.findByRole('button', { name: /Ready/ }));
	expect(open).toHaveBeenCalledWith('c1');
	expect(screen.getByRole('button', { name: /Running/ })).toBeTruthy();
	expect(screen.getByText('claude · quick blueprint · mob/ui-2')).toBeTruthy();
	// The blueprints' steps were for deciding; once started, the tasks say where they are.
	expect(screen.queryByText(/checks, then review/)).toBeNull();
});
