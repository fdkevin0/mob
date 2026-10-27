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
	const rename = vi.fn();
	const remove = vi.fn();
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
		rename,
		remove,
		keep: () => {},
		disconnect: () => {},
	};
	const { rerender } = render(<Sidebar {...props} />);
	const list = screen.getByRole('navigation', { name: 'Conversations' });
	expect(
		within(list)
			.getByRole('button', { name: /^Fix Safari export/ })
			.getAttribute('aria-current'),
	).toBe('page');
	expect(within(list).getByRole('button', { name: /^Fix Safari export/ }).textContent).toContain('Replying');
	expect(within(list).getByRole('button', { name: /^周报草稿/ }).textContent).toContain('Waiting for your approval');
	fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'docs' } });
	expect(
		[...list.querySelectorAll('.conversation-link')].map((b) => b.textContent),
	).toEqual(['Docs layout']);
	fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'nothing like it' } });
	expect(list.textContent).toContain('No conversation is called “nothing like it”.');
	fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: '' } });
	rerender(<Sidebar {...props} locked />);
	expect((within(list).getByRole('button', { name: /^Docs layout/ }) as HTMLButtonElement).disabled).toBe(true);
	expect((within(list).getByRole('button', { name: /^Fix Safari export/ }) as HTMLButtonElement).disabled).toBe(false);
	expect((screen.getByRole('button', { name: 'Agents' }) as HTMLButtonElement).disabled).toBe(false);
	expect(screen.getByRole('button', { name: 'This computer: settings and runner' }).textContent).toContain(
		'Keeps running in the background',
	);
});

it('renames a conversation in place, and asks to delete one that is not replying', () => {
	const rename = vi.fn();
	const remove = vi.fn();
	const conversations = [
		{ id: 'one', title: 'Fix Safari export', updatedAt: Date.now(), active: true },
		{ id: 'two', title: 'Docs layout', updatedAt: Date.now() },
	];
	render(
		<Sidebar
			connection={{ url: 'http://localhost', token: 't' }}
			conversations={conversations}
			selected="one"
			view="chat"
			locked={false}
			background={false}
			keeping={false}
			create={() => {}}
			open={() => {}}
			prefetch={() => {}}
			show={() => {}}
			rename={rename}
			remove={remove}
			keep={() => {}}
			disconnect={() => {}}
		/>,
	);
	const menu = (title: string) => {
		fireEvent.keyDown(screen.getByRole('button', { name: `More for ${title}` }), { key: 'Enter' });
		return screen.getByRole('menu');
	};
	fireEvent.click(within(menu('Docs layout')).getByRole('menuitem', { name: 'Rename' }));
	const field = screen.getByLabelText('Conversation title') as HTMLInputElement;
	expect(field.value).toBe('Docs layout');
	fireEvent.keyDown(field, { key: 'Escape' });
	expect(screen.queryByLabelText('Conversation title')).toBeNull();
	expect(rename).not.toHaveBeenCalled();

	fireEvent.click(within(menu('Docs layout')).getByRole('menuitem', { name: 'Rename' }));
	fireEvent.change(screen.getByLabelText('Conversation title'), { target: { value: '  Docs   site layout ' } });
	fireEvent.submit(screen.getByLabelText('Conversation title').closest('form')!);
	expect(rename).toHaveBeenCalledWith('two', 'Docs site layout');

	// Mob refuses to delete a conversation while it replies there.
	expect(within(menu('Fix Safari export')).getByRole('menuitem', { name: 'Delete' }).getAttribute('aria-disabled')).toBe('true');
	fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
	fireEvent.click(within(menu('Docs layout')).getByRole('menuitem', { name: 'Delete' }));
	expect(remove).toHaveBeenCalledWith(conversations[1]);
});
