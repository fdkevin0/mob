import { forwardRef, useEffect, useImperativeHandle } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { social, reset } = vi.hoisted(() => ({ social: vi.fn(), reset: vi.fn() }));
vi.mock('./auth', () => ({ authClient: { signIn: { social } }, signedInURL: '/?signin=done' }));
vi.mock('./Turnstile', () => ({
  Turnstile: forwardRef<{ reset: () => void }, { onToken: (token: string) => void }>(function Turnstile({ onToken }, ref) {
    useImperativeHandle(ref, () => ({ reset() { reset(); onToken('again'); } }), [onToken]);
    useEffect(() => onToken('token'), [onToken]);
    return null;
  }),
}));

import { SignIn } from './SignIn';

const site = { turnstileSiteKey: 'key', ready: true };
afterEach(() => { social.mockReset(); reset.mockReset(); });

it('sends GitHub back to a fixed address that carries no pairing code', async () => {
  social.mockReturnValue(new Promise(() => {}));
  render(<SignIn site={site} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Continue with GitHub/ }));
  expect(social).toHaveBeenCalledWith(
    { provider: 'github', callbackURL: '/?signin=done', errorCallbackURL: '/?signin=failed' },
    { headers: { 'x-captcha-response': 'token' } },
  );
  expect(screen.getByRole('button', { name: /Opening GitHub/ }).hasAttribute('disabled')).toBe(true);
});

it('lets the visitor try again after a network failure', async () => {
  social.mockRejectedValue(new TypeError('Failed to fetch'));
  render(<SignIn site={site} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Continue with GitHub/ }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the sign-in service/);
  expect(reset).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', { name: /Continue with GitHub/ }).hasAttribute('disabled')).toBe(false));
});

it('shows the error the service returns and resets the check', async () => {
  social.mockResolvedValue({ error: { message: 'Captcha failed' } });
  render(<SignIn site={site} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Continue with GitHub/ }));
  expect((await screen.findByRole('alert')).textContent).toBe('Captcha failed');
  expect(reset).toHaveBeenCalled();
});
