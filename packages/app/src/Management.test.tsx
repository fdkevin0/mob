import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Management } from './Management';

const connection = { url: 'http://localhost', token: 'test' };
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
it('shows memory scope and requires confirmation before deleting', async () => {
	const calls: string[] = [];
	let memories = [{ id: 'one', text: 'Prefer short answers', owner: true, conversationId: 'c' }];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			const path = new URL(url).pathname;
			calls.push(path);
			if (path === '/api/commands') return Response.json([{ name: 'memories' }]);
			if (path.endsWith('/delete')) {
				memories = [];
				return Response.json({ removed: 1 });
			}
			return Response.json(memories);
		}),
	);
	render(<Management connection={connection} tab="memories" select={() => {}} open={() => {}} held={() => false} />);
	await screen.findByText('Prefer short answers');
	expect(screen.getByText('All your conversations')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));
	expect(calls.some((p) => p.endsWith('/delete'))).toBe(false);
	fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
	await screen.findByText('No saved memories.');
	expect(calls.filter((p) => p.endsWith('/delete'))).toEqual(['/api/memories/one/delete']);
});
it('saves project checks as separate strings, preserving multiline commands and paths with spaces', async () => {
	const saved: unknown[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (new URL(url).pathname === '/api/commands') return Response.json([{ name: 'projects' }]);
			if (init?.method === 'POST') {
				saved.push(JSON.parse(init.body as string));
				return Response.json({});
			}
			return Response.json({
				projects: [{ name: 'demo', path: '/repo with spaces', checks: ['echo first\necho second'] }],
				blueprints: [{ name: 'standard', title: 'Standard', description: 'Checks then review' }],
			});
		}),
	);
	render(<Management connection={connection} tab="projects" select={() => {}} open={() => {}} held={() => false} />);
	const check = await screen.findByLabelText('Check 1');
	fireEvent.change(check, { target: { value: 'bun test\nbun run build' } });
	fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
	await waitFor(() =>
		expect(saved).toEqual([
			{ action: 'save', name: 'demo', path: '/repo with spaces', blueprint: 'standard', checks: ['bun test\nbun run build'] },
		]),
	);
});
it('does not fetch a plugin missing on this Mob', async () => {
	const fetch = vi.fn(async () => Response.json([]));
	vi.stubGlobal('fetch', fetch);
	render(<Management connection={connection} tab="mcp" select={() => {}} open={() => {}} held={() => false} />);
	await screen.findByText(/This feature is not available/);
	expect(fetch).toHaveBeenCalledTimes(1);
});
