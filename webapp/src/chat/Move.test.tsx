import { Dialog } from '../components/ui/dialog';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Move } from './Move';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('copies the chosen conversations from a local Mob into this browser and opens it', async () => {
	const transfer = { v: 1, title: 'Plan', model: '', summary: '', summaryThrough: '', messages: [], facts: [], usage: [] };
	const imported: unknown[] = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		if (url === '/api/runners') return Response.json([]);
		if (url === 'http://127.0.0.1:8787/api/conversations/one/export') return Response.json(transfer);
		if (url === 'http://localhost/api/conversations/import') { imported.push(JSON.parse(String(init?.body))); return Response.json({ id: 'new', title: 'Plan', updatedAt: 1 }); }
		return new Response('unexpected ' + url, { status: 500 });
	}));
	vi.stubEnv('MODE', 'public');
	vi.doMock('./browser/browser', () => ({ startBrowser: async () => ({ persistent: true }), browserFetch: (input: string, init?: RequestInit) => fetch(input, init) }));
	const switched = vi.fn();
	try {
		render(<Dialog defaultOpen><Move connection={{ url: 'http://127.0.0.1:8787', token: 't' }} conversations={[{ id: 'one', title: 'Plan', updatedAt: 1 }, { id: 'two', title: 'Other', updatedAt: 0 }]} selected="one" onSwitch={switched} /></Dialog>);
		const copy = await screen.findByRole('button', { name: 'Copy 1 to This browser' });
		fireEvent.click(copy);
		await screen.findByText('Plan: copied');
		expect(imported).toEqual([transfer]);
		fireEvent.click(screen.getByRole('button', { name: 'Open This browser' }));
		await waitFor(() => expect(switched).toHaveBeenCalledWith(expect.objectContaining({ browser: true })));
	} finally { vi.unstubAllEnvs(); }
});
