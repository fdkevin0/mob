import { render, screen } from '@testing-library/react';
import { afterAll, expect, it, vi } from 'vitest';

// Better Auth keeps the fetch it finds when the client is made.
let user: object | null = null;
const fetch = vi.fn(async () => Response.json(user ? { user, session: { id: 's', expiresAt: new Date(Date.now() + 3600e3).toISOString() } } : null));
vi.stubGlobal('fetch', fetch);
const { UserMenu } = await import('./UserMenu');
afterAll(() => { vi.unstubAllGlobals(); localStorage.clear(); });

// A page prerendered on hover checks the session before the visitor opens it;
// signing out on the current page in between must not leave the old account.
it('checks the session again when a prerendered page is shown', async () => {
	user = { id: '1', name: 'Ada', email: 'ada@example.test', image: null };
	render(<UserMenu />);
	expect(await screen.findByRole('button', { name: 'Account' })).toBeTruthy();
	user = null;
	document.dispatchEvent(new Event('prerenderingchange'));
	expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
	expect(localStorage.getItem('mob-account-hint')).toBeNull();
});
