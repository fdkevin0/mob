import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
	session: { isPending: false, data: null } as { isPending: boolean; data: null | { user: { name: string; email: string; image: string | null } } },
	signOut: vi.fn(),
}));
vi.mock('./auth', () => ({ authClient: { useSession: () => auth.session, signOut: auth.signOut } }));
import { SiteHeader } from '../components/site/Site';

beforeEach(() => { auth.session = { isPending: false, data: null }; auth.signOut.mockReset(); });

it.each(['/', '/demo', '/docs/', '/account'])('keeps the same public navigation on %s', current => {
	render(<SiteHeader current={current} />);
	const nav = within(screen.getByRole('navigation', { name: 'Site' }));
	expect(nav.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
		['Home', '/'], ['Demo', '/demo'], ['Docs', '/docs/'], ['GitHub', 'https://github.com/fdkevin0/mob'],
	]);
	expect(screen.queryByRole('link', { name: 'Account' })).toBeNull();
	expect(screen.getByRole('link', { name: 'Open Mob' }).getAttribute('href')).toBe('/app');
	expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
	if (current !== '/account') expect(screen.getByRole('link', { current: 'page' }).getAttribute('href')).toBe(current);
	expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
});

it('reserves the user control while session state loads', () => {
	auth.session.isPending = true;
	render(<SiteHeader />);
	expect(screen.getByRole('button', { name: 'Loading account' }).hasAttribute('disabled')).toBe(true);
	expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
});

it('shows the avatar after Open Mob and falls back to an initial if the image fails', () => {
	auth.session.data = { user: { name: 'Ada', email: 'ada@example.test', image: 'https://example.test/avatar.png' } };
	render(<SiteHeader />);
	const button = screen.getByRole('button', { name: 'Account' });
	expect(button.previousElementSibling?.textContent).toBe('Open Mob');
	const image = button.querySelector('img')!;
	expect(image.src).toBe('https://example.test/avatar.png');
	fireEvent.error(image);
	expect(button.textContent).toBe('A');
});

it('puts account and sign-out in the avatar menu, and reports sign-out errors', async () => {
	auth.session.data = { user: { name: 'Ada', email: 'ada@example.test', image: null } };
	auth.signOut.mockResolvedValue({ error: { message: 'Offline' } });
	render(<SiteHeader />);
	fireEvent.keyDown(screen.getByRole('button', { name: 'Account' }), { key: 'Enter' });
	expect((await screen.findByRole('menuitem', { name: 'Account' })).getAttribute('href')).toBe('/account');
	fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
	await waitFor(() => expect(auth.signOut).toHaveBeenCalledOnce());
	expect((await screen.findByRole('alert')).textContent).toContain('Could not sign out');
});

it('opens the mobile navigation with docs search and theme controls', async () => {
	render(<SiteHeader current="/demo" />);
	fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
	const drawer = within(await screen.findByRole('dialog', { name: 'Navigation' }));
	expect(drawer.getByRole('link', { name: 'Search docs' }).getAttribute('href')).toBe('/docs/?search');
	expect(drawer.getByRole('link', { current: 'page' }).textContent).toBe('Demo');
	expect(drawer.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
	fireEvent.click(drawer.getByRole('button', { name: 'Close' }));
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
