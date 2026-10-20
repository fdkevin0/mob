import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
	session: { isPending: false, data: { user: { name: 'Ada', email: 'ada@example.test', image: null } }, error: null } as unknown,
	passkeys: { isPending: false, data: [] as unknown[], error: null } as unknown,
	listAccounts: vi.fn(),
	addPasskey: vi.fn(),
	updatePasskey: vi.fn(),
	deletePasskey: vi.fn(),
	signOut: vi.fn(),
}));
vi.mock('../landing/auth', () => ({
	authClient: {
		useSession: () => auth.session,
		useListPasskeys: () => auth.passkeys,
		listAccounts: auth.listAccounts,
		passkey: { addPasskey: auth.addPasskey, updatePasskey: auth.updatePasskey, deletePasskey: auth.deletePasskey },
		signOut: auth.signOut,
	},
	errorCode: (error: { code?: string }) => error.code,
}));

import { Account } from './Account';

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: function PublicKeyCredential() {} });
	auth.listAccounts.mockResolvedValue({ data: [{ id: 'a', providerId: 'github', createdAt: '2026-10-01T00:00:00Z' }], error: null });
	auth.signOut.mockResolvedValue({});
	assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const mock of [auth.listAccounts, auth.addPasskey, auth.updatePasskey, auth.deletePasskey, auth.signOut]) mock.mockReset();
	auth.passkeys = { isPending: false, data: [], error: null };
	auth.session = { isPending: false, data: { user: { name: 'Ada', email: 'ada@example.test', image: null } }, error: null };
});

it('shows the GitHub account and adds a named passkey', async () => {
	auth.addPasskey.mockResolvedValue({ data: { id: 'p1' }, error: null });
	render(<Account />);
	expect(screen.getByText('ada@example.test')).toBeTruthy();
	expect(await screen.findByText(/^Connected/)).toBeTruthy();
	expect(screen.getByText('No passkeys yet.')).toBeTruthy();
	fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Work laptop ' } });
	fireEvent.click(screen.getByRole('button', { name: /Add a passkey/ }));
	await screen.findByRole('status');
	expect(auth.addPasskey).toHaveBeenCalledWith({ name: 'Work laptop' });
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
