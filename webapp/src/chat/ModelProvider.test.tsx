import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelProvider } from './ModelProvider';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it('saves a provider on a runner, where a model server on that machine needs no key', async () => {
	const posts: { url: string; body: unknown }[] = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		if (init?.method === 'POST') {
			posts.push({ url, body: JSON.parse(String(init.body)) });
			return Response.json({ default: 'ollama/qwen3', models: 3 });
		}
		return Response.json({ default: '', providers: [] });
	}));
	const saved = vi.fn();
	render(<ModelProvider connection={{ url: 'http://localhost', token: 't' }} open onOpenChange={() => {}} onSaved={saved} />);
	expect(screen.getByText(/keeps the key in its providers\.json/)).toBeDefined();
	// Workers AI through the site's sign-in, like OpenRouter's own sign-in, is the browser runner's alone.
	expect(screen.queryByRole('option', { name: /Cloudflare Workers AI/ })).toBeNull();
	// Only the browser runner signs in with OpenRouter itself.
	fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'openrouter' } });
	expect(screen.queryByRole('button', { name: 'Sign in with OpenRouter' })).toBeNull();
	fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'ollama' } });
	expect((screen.getByLabelText('API key (optional)') as HTMLInputElement).required).toBe(false);
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(saved).toHaveBeenCalledWith('ollama/qwen3'));
	expect(posts).toEqual([{ url: 'http://localhost/api/providers', body: { preset: 'ollama', url: '', protocol: 'chat', key: '', model: '' } }]);
	expect(screen.getByRole('status').textContent).toContain('Conversations now use ollama/qwen3');
});

it('offers Workers AI of the signed-in Cloudflare account only in the browser', () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ default: '', providers: [] })));
	render(<ModelProvider connection={{ url: '', token: '', browser: true } as never} open onOpenChange={() => {}} />);
	fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'cloudflare' } });
	expect(screen.getByRole('button', { name: 'Use my Cloudflare account' })).toBeDefined();
	expect(screen.queryByLabelText('API key')).toBeNull();
});
