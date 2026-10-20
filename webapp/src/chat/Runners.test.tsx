import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Runners } from './Runners';
import { hosts } from './hosts';

const id = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

it('keeps pairing keys in this browser and opens and revokes the owned runner', async () => {
	let claimed = false;
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init?: RequestInit) => {
			calls.push(String(init?.body ?? ''));
			if (init?.method === 'POST') return Response.json({ id, code: 'one-time-code', expiresAt: Date.now() + 300000 });
			if (init?.method === 'DELETE') {
				claimed = false;
				return Response.json({ revoked: true });
			}
			return Response.json(claimed ? [{ id, session: 'a'.repeat(64) }] : []);
		}),
	);
	const connect = vi.fn();
	render(<Runners connect={connect} />);
	fireEvent.click(screen.getByRole('button', { name: 'Pair a runner' }));
	const field = (await screen.findByLabelText(/Private pairing JSON/)) as HTMLTextAreaElement;
	const pair = JSON.parse(field.value);
	expect(pair).toMatchObject({ id, url: location.origin, code: 'one-time-code' });
	expect(atob(pair.key)).toHaveLength(32);
	expect(localStorage.getItem(`mob-runner-key:${id}`)).toBe(pair.key);
	expect(calls.join('')).not.toContain(pair.key);
	claimed = true;
	// Re-mount to refresh without waiting for the polling interval.
	const next = render(<Runners connect={connect} />);
	fireEvent.click(await screen.findByRole('button', { name: 'Open runner' }));
	expect(connect).toHaveBeenCalledWith(expect.objectContaining({ token: '', runner: { id, key: pair.key } }));
	fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
	await waitFor(() => expect(localStorage.getItem(`mob-runner-key:${id}`)).toBeNull());
	next.unmount();
});

it('does not send requests to a runner whose key is missing', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json([{ id, session: 'a'.repeat(64) }])),
	);
	const connect = vi.fn();
	render(<Runners connect={connect} />);
	fireEvent.click(await screen.findByRole('button', { name: 'Open runner' }));
	expect(screen.getByRole('alert').textContent).toContain('no key');
	expect(connect).not.toHaveBeenCalled();
});

it('gives a Render runner its credential at once instead of a one-time code', async () => {
	let body = '';
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === 'POST') {
				body = String(init.body);
				return Response.json({ id, token: 'runner-token' });
			}
			return Response.json([]);
		}),
	);
	render(<Runners connect={vi.fn()} deploy />);
	fireEvent.click(screen.getByRole('button', { name: 'Create cloud pairing' }));
	const field = (await screen.findByLabelText(/Private pairing JSON/)) as HTMLTextAreaElement;
	const pair = JSON.parse(field.value);
	expect(JSON.parse(body)).toEqual({ for: 'deploy' });
	expect(pair).toMatchObject({ id, url: location.origin, token: 'runner-token' });
	expect(pair.code).toBeUndefined();
	expect(body).not.toContain(pair.key);
	expect(screen.getByRole('link', { name: 'Deploy to Render' }).getAttribute('href')).toBe(hosts[0].deployURL);
	// A host whose one-click template is not published yet cannot be picked.
	for (const host of hosts.filter((h) => !h.deployURL)) expect((screen.getByRole('radio', { name: new RegExp(host.name) }) as HTMLButtonElement).disabled).toBe(true);
});
