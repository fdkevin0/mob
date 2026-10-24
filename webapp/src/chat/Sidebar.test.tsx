import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { groups, Sidebar } from './Sidebar';

afterEach(cleanup);

it('groups conversations by how long ago they changed', () => {
	const now = new Date(2026, 9, 24, 15).getTime();
	const at = (days: number, hour = 9) => new Date(2026, 9, 24 - days, hour).getTime();
	const list = [
		{ id: 'a', title: 'This morning', updatedAt: at(0) },
		{ id: 'b', title: 'Last night', updatedAt: at(1, 23) },
		{ id: 'c', title: 'Monday', updatedAt: at(4) },
		{ id: 'd', title: 'Last month', updatedAt: at(20) },
		{ id: 'e', title: 'Long ago', updatedAt: at(90) },
		{ id: 'f', title: 'Unknown', updatedAt: undefined as unknown as number },
	];
	expect(groups(list, now).map((g) => [g.label, g.conversations.map((c) => c.id)])).toEqual([
		['Today', ['a', 'f']],
		['Yesterday', ['b']],
		['Previous 7 days', ['c']],
		['Previous 30 days', ['d']],
		['Earlier', ['e']],
	]);
});

it('marks replying and waiting conversations, finds them by title, and holds the others while a message is on its way', () => {
	const open = vi.fn();
	const props = {
		connection: { url: 'http://localhost', token: 't' },
		conversations: [
			{ id: 'one', title: 'Fix Safari export', updatedAt: Date.now(), active: true },
			{ id: 'two', title: '周报草稿', updatedAt: Date.now(), waiting: true },
			{ id: 'three', title: 'Docs layout', updatedAt: Date.now() },
		],
		selected: 'one',
		view: 'chat' as const,
		locked: false,
		background: true,
		keeping: false,
		create: () => {},
		open,
		prefetch: () => {},
		show: () => {},
		keep: () => {},
		disconnect: () => {},
	};
	const { rerender } = render(<Sidebar {...props} />);
	const list = screen.getByRole('navigation', { name: 'Conversations' });
	expect(
		within(list)
			.getByRole('button', { name: /Fix Safari export/ })
			.getAttribute('aria-current'),
	).toBe('page');
	expect(within(list).getByRole('button', { name: /Fix Safari export/ }).textContent).toContain('Replying');
	expect(within(list).getByRole('button', { name: /周报草稿/ }).textContent).toContain('Waiting for your approval');
	fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'docs' } });
	expect(
		within(list)
			.getAllByRole('button')
			.map((b) => b.textContent),
	).toEqual(['Docs layout']);
	fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'nothing like it' } });
	expect(list.textContent).toContain('No conversation is called “nothing like it”.');
	fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: '' } });
	rerender(<Sidebar {...props} locked />);
	expect((within(list).getByRole('button', { name: /Docs layout/ }) as HTMLButtonElement).disabled).toBe(true);
	expect((within(list).getByRole('button', { name: /Fix Safari export/ }) as HTMLButtonElement).disabled).toBe(false);
	expect((screen.getByRole('button', { name: 'Agents' }) as HTMLButtonElement).disabled).toBe(false);
	expect(screen.getByRole('button', { name: 'This computer: settings and runner' }).textContent).toContain(
		'Keeps running in the background',
	);
});
