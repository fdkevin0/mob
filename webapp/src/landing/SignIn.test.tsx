import { Dialog } from '../components/ui/dialog';
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { social, passkey, openApp, reset } = vi.hoisted(() => ({ social: vi.fn(), passkey: vi.fn(), openApp: vi.fn(), reset: vi.fn() }));
vi.mock('./auth', () => ({
  authClient: { signIn: { social, passkey } },
  signedInURL: '/?signin=done',
  openApp,
  errorCode: (error: { code?: string }) => error.code,
}));
vi.mock('./Turnstile', () => ({
  Turnstile: forwardRef<{ reset: () => void }, { onToken: (token: string) => void }>(function Turnstile({ onToken }, ref) {
    useImperativeHandle(ref, () => ({ reset() { reset(); onToken('again'); } }), [onToken]);
    useEffect(() => onToken('token'), [onToken]);
    return null;
  }),
}));

import { SignIn } from './SignIn';

const site = { turnstileSiteKey: 'key', ready: true };
afterEach(() => { social.mockReset(); passkey.mockReset(); openApp.mockReset(); reset.mockReset(); });
Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: function PublicKeyCredential() {} });

it('sends GitHub back to a fixed address that carries no pairing code', async () => {
  social.mockReturnValue(new Promise(() => {}));
  render(<Dialog defaultOpen><SignIn site={site} /></Dialog>);
  fireEvent.click(await screen.findByRole('button', { name: /Continue with GitHub/ }));
  expect(social).toHaveBeenCalledWith(
    { provider: 'github', callbackURL: '/?signin=done', errorCallbackURL: '/?signin=failed' },
    { headers: { 'x-captcha-response': 'token' } },
  );
  expect(screen.getByRole('button', { name: /Opening GitHub/ }).hasAttribute('disabled')).toBe(true);
});

it('lets the visitor try again after a network failure', async () => {
  social.mockRejectedValue(new TypeError('Failed to fetch'));
  render(<Dialog defaultOpen><SignIn site={site} /></Dialog>);
  fireEvent.click(await screen.findByRole('button', { name: /Continue with GitHub/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the sign-in service/);
  expect(reset).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', { name: /Continue with GitHub/ }).hasAttribute('disabled')).toBe(false));
});

it('shows the error the service returns and resets the check', async () => {
  social.mockResolvedValue({ error: { message: 'Captcha failed' } });
  render(<Dialog defaultOpen><SignIn site={site} /></Dialog>);
  fireEvent.click(await screen.findByRole('button', { name: /Continue with GitHub/ }));
  expect((await screen.findByRole('alert')).textContent).toBe('Captcha failed');
  expect(reset).toHaveBeenCalled();
});

it('signs in with a passkey without the human check and opens the app', async () => {
  passkey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
  render(<Dialog defaultOpen><SignIn site={site} /></Dialog>);
  fireEvent.click(await screen.findByRole('button', { name: /Sign in with a passkey/ }));
  await waitFor(() => expect(openApp).toHaveBeenCalled());
  expect(passkey).toHaveBeenCalledWith();
  expect(social).not.toHaveBeenCalled();
});

it('explains a passkey that belongs to no account', async () => {
  passkey.mockResolvedValue({ data: null, error: { code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' } });
  render(<Dialog defaultOpen><SignIn site={site} /></Dialog>);
  fireEvent.click(await screen.findByRole('button', { name: /Sign in with a passkey/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Continue with GitHub, then add it on your account page/);
  expect(openApp).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Sign in with a passkey/ }).hasAttribute('disabled')).toBe(false);
});
