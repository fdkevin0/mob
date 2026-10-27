import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
	session: { isPending: false, data: { user: { name: 'Ada', email: 'ada@example.test', image: null } }, error: null } as unknown,
	passkeys: { isPending: false, data: [] as unknown[], error: null } as unknown,
	listAccounts: vi.fn(),
	accountInfo: vi.fn(),
	addPasskey: vi.fn(),
	updatePasskey: vi.fn(),
	deletePasskey: vi.fn(),
	signOut: vi.fn(),
	linkSocial: vi.fn(),
	unlinkAccount: vi.fn(),
	loadSite: vi.fn(),
}));
vi.mock('../landing/auth', () => ({
	authClient: {
		useSession: () => auth.session,
		useListPasskeys: () => auth.passkeys,
		listAccounts: auth.listAccounts,
		accountInfo: auth.accountInfo,
		passkey: { addPasskey: auth.addPasskey, updatePasskey: auth.updatePasskey, deletePasskey: auth.deletePasskey },
		signOut: auth.signOut,
		linkSocial: auth.linkSocial,
		unlinkAccount: auth.unlinkAccount,
	},
	errorCode: (error: { code?: string }) => error.code,
	loadSite: auth.loadSite,
}));

import { Account } from './Account';

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: function PublicKeyCredential() {} });
	auth.listAccounts.mockResolvedValue({ data: [{ id: 'a', providerId: 'github', createdAt: '2026-10-01T00:00:00Z' }], error: null });
	auth.signOut.mockResolvedValue({});
	auth.loadSite.mockResolvedValue({ turnstileSiteKey: 'k', ready: true });
	auth.accountInfo.mockResolvedValue({ data: { user: {}, data: { login: 'ada-l' } }, error: null });
	assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const mock of [auth.listAccounts, auth.accountInfo, auth.addPasskey, auth.updatePasskey, auth.deletePasskey, auth.signOut, auth.linkSocial, auth.unlinkAccount, auth.loadSite]) mock.mockReset();
	auth.passkeys = { isPending: false, data: [], error: null };
	auth.session = { isPending: false, data: { user: { name: 'Ada', email: 'ada@example.test', image: null } }, error: null };
});

it('shows the GitHub username and adds a passkey the server names', async () => {
	auth.addPasskey.mockResolvedValue({ data: { id: 'p1' }, error: null });
	render(<Account />);
	expect(screen.getByText('ada@example.test')).toBeTruthy();
	expect(await screen.findByText(/^Connected/)).toBeTruthy();
	const login = await screen.findByRole('link', { name: '@ada-l' });
	expect(login.getAttribute('href')).toBe('https://github.com/ada-l');
	expect(auth.accountInfo).toHaveBeenCalledWith({ query: { accountId: 'a' } });
	expect(screen.getByText('No passkeys yet.')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: /Add a passkey/ }));
	await screen.findByRole('status');
	expect(auth.addPasskey).toHaveBeenCalledWith();
});

it('still shows GitHub as connected when GitHub does not answer', async () => {
	auth.accountInfo.mockResolvedValue({ data: null, error: { message: 'Failed to get user info', status: 401 } });
	render(<Account />);
	expect(await screen.findByText(/^Connected/)).toBeTruthy();
	await waitFor(() => expect(auth.accountInfo).toHaveBeenCalled());
	expect(screen.queryByRole('link', { name: /^@/ })).toBeNull();
	expect(screen.queryByRole('alert')).toBeNull();
});

it('asks for a fresh GitHub sign-in when the session is too old to add a passkey', async () => {
	auth.addPasskey.mockResolvedValue({ data: null, error: { code: 'SESSION_NOT_FRESH', message: 'Session is not fresh', status: 403 } });
	render(<Account />);
	fireEvent.click(screen.getByRole('button', { name: /Add a passkey/ }));
	fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
	await waitFor(() => expect(assign).toHaveBeenCalledWith('/?signin=account'));
	expect(auth.signOut).toHaveBeenCalled();
});

it('renames and removes a passkey', async () => {
	auth.passkeys = { isPending: false, data: [{ id: 'p1', name: 'Phone', createdAt: '2026-10-02T00:00:00Z', backedUp: true, deviceType: 'multiDevice' }], error: null };
	auth.updatePasskey.mockResolvedValue({ data: {}, error: null });
	auth.deletePasskey.mockResolvedValue({ data: {}, error: null });
	Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
	render(<Account />);
	const row = screen.getByText('Phone').closest('li')!;
	expect(within(row).getByText(/Synced/)).toBeTruthy();
	fireEvent.click(within(row).getByRole('button', { name: 'Rename Phone' }));
	fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'Pixel' } });
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(auth.updatePasskey).toHaveBeenCalledWith({ id: 'p1', name: 'Pixel' }));
	fireEvent.click(await screen.findByRole('button', { name: 'Remove Phone' }));
	await waitFor(() => expect(auth.deletePasskey).toHaveBeenCalledWith({ id: 'p1' }));
});

it('sends a signed-out visitor to sign in', async () => {
	auth.session = { isPending: false, data: null, error: null };
	render(<Account />);
	await waitFor(() => expect(assign).toHaveBeenCalledWith('/?signin=account'));
});

it('connects Cloudflare to the account when the site offers it', async () => {
	auth.loadSite.mockResolvedValue({ turnstileSiteKey: 'k', ready: true, cloudflare: true });
	auth.linkSocial.mockReturnValue(new Promise(() => {}));
	render(<Account />);
	const row = (await screen.findByText('Cloudflare')).closest('li')!;
	fireEvent.click(await within(row).findByRole('button', { name: 'Connect' }));
	expect(auth.linkSocial).toHaveBeenCalledWith({ provider: 'cloudflare', callbackURL: '/account', errorCallbackURL: '/account' });
});

it('disconnects Cloudflare while GitHub still signs in', async () => {
	auth.listAccounts.mockResolvedValue({ data: [{ id: 'a', providerId: 'github', createdAt: '2026-10-01T00:00:00Z' }, { id: 'c', providerId: 'cloudflare', createdAt: '2026-10-02T00:00:00Z' }], error: null });
	auth.unlinkAccount.mockResolvedValue({ data: {}, error: null });
	Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
	render(<Account />);
	const row = (await screen.findByText('Cloudflare')).closest('li')!;
	fireEvent.click(await within(row).findByRole('button', { name: 'Disconnect' }));
	await waitFor(() => expect(auth.unlinkAccount).toHaveBeenCalledWith({ accountId: 'c' }));
	await waitFor(() => expect(auth.listAccounts).toHaveBeenCalledTimes(2));
});

it('says why connecting an account did not finish', async () => {
	window.history.replaceState(null, '', '/account?error=unable_to_link_account');
	render(<Account />);
	expect((await screen.findByRole('alert')).textContent).toMatch(/unable_to_link_account/);
	expect(window.location.search).toBe('');
});
