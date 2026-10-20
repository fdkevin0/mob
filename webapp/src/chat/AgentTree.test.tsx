import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentTree, duration, link, tree } from './AgentTree';
import type { AgentNode, Task } from './contracts';

afterEach(() => vi.unstubAllGlobals());

const task = (id: string, status: string, createdAt: number, updatedAt: number, parent?: string): Task => ({
	id,
	conversationId: `c-${id}`,
	project: 'mob',
	agent: 'codex',
	title: id,
	worktree: '/w',
	branch: `mob/${id}`,
	status,
	parent,
	createdAt,
	updatedAt,
});
const node = (t: Task, extra: Partial<AgentNode> = {}): AgentNode => ({
	conversationId: t.conversationId,
	parent: t.parent,
	agent: t.agent,
	label: 'Codex',
	title: t.title,
	status: t.status,
	approvals: 0,
	tools: [],
	task: t,
	...extra,
});
const nodes: AgentNode[] = [
	node(task('build', 'running', 1000, 2000, 'm1'), {
		tools: ['execute', 'edit'],
		usage: {
			totalTokens: 12400,
			inputTokens: 12000,
			outputTokens: 400,
			reasoningTokens: 100,
			cacheReadTokens: 9000,
			cacheWriteTokens: 0,
			cost: 0.29,
			durationMs: 0,
			requests: 3,
			turns: 1,
			models: [],
		},
	}),
	node(task('copy', 'waiting', 1000, 3000, 'm1'), { approvals: 1 }),
	node(task('test', 'failed', 5000, 9000, 'c-build')),
	node(task('lonely', 'review', 0, 500)),
	{ conversationId: 'm1', agent: 'mob', label: 'Mob', title: 'Launch pricing', status: 'idle', approvals: 0, tools: [] },
];

it('routes fanned-out links across and nested ones down the side', () => {
	const parent = { left: 100, top: 0, right: 300, bottom: 100 };
	expect(link(parent, { left: 0, top: 160, right: 200, bottom: 250 }, true)).toEqual({
		d: 'M200 100V120Q200 130 190 130H110Q100 130 100 140V160',
		x: 200,
		y: 100,
	});
	expect(link(parent, { left: 100, top: 160, right: 300, bottom: 250 }, true).d).toBe('M200 100V160');
	expect(link(parent, { left: 140, top: 120, right: 400, bottom: 200 }, false).d).toBe('M122 100V133Q122 142 131 142H140');
});

it('nests tasks under who started them and times each branch', () => {
	const [first, second] = tree(nodes, 10000);
	expect(first.node.conversationId).toBe('m1');
	expect(first.children.map((c) => c.node.title)).toEqual(['build', 'copy']);
	expect(first.children[0].children[0].node.title).toBe('test');
	// A running task is timed until now; a parent spans its children.
	expect(first.children[0].end - first.children[0].start).toBe(9000);
	expect(first.end - first.start).toBe(9000);
	expect(second.node.title).toBe('lonely');
	expect(duration(45_000)).toBe('45s');
	expect(duration(192_000)).toBe('3m 12s');
});

it('shows cards, filters what needs the owner and opens a conversation', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(nodes)));
	const open = vi.fn();
	render(<AgentTree connection={{ url: 'http://127.0.0.1:1', token: 't' }} open={open} close={() => {}} />);
	expect(await screen.findByText('5 agents')).toBeTruthy();
	// What the agents used shows on their cards and adds up in the header.
	expect(screen.getByText('$0.290 · 12k tokens')).toBeTruthy();
	expect(screen.getByText('$0.290', { selector: '.agents-total' })).toBeTruthy();
	expect(screen.getAllByRole('article')).toHaveLength(5);
	fireEvent.click(screen.getByRole('button', { name: '1 needs you' }));
	const cards = screen.getAllByRole('article');
	expect(cards).toHaveLength(2);
	expect(within(cards[1]).getByText('Needs you')).toBeTruthy();
	fireEvent.click(within(cards[1]).getByRole('button', { name: 'Open Codex: copy' }));
	expect(open).toHaveBeenCalledWith('c-copy');
	fireEvent.click(screen.getByRole('button', { name: '1 needs you' }));
	// Clicking a card folds the agents it started, and clicking it again shows them.
	const root = screen.getAllByRole('article')[0];
	fireEvent.click(root);
	expect(screen.getAllByRole('article')).toHaveLength(2);
	expect(within(root).getByRole('button', { name: 'Show 3 agents started by Mob' }).textContent).toContain('+3');
	fireEvent.click(root);
	expect(screen.getAllByRole('article')).toHaveLength(5);
	// Runtimes and models show their logos.
	expect(screen.getAllByRole('img', { name: 'Codex' }).length).toBe(4);
	expect(screen.getAllByRole('img', { name: 'OpenAI' }).length).toBe(4);
});
