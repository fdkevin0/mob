import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
	expect(screen.getByText(/keys kept in its providers\.json/)).toBeDefined();
	// Workers AI through the site's sign-in, like OpenRouter's own sign-in, is the browser runner's alone.
	expect(screen.queryByRole('button', { name: /Workers AI/ })).toBeNull();
	// Only the browser runner signs in with OpenRouter itself; a runner takes its key, with a link to make one.
	fireEvent.click(screen.getByRole('button', { name: /^OpenRouter/ }));
	expect(screen.queryByRole('button', { name: 'Sign in with OpenRouter' })).toBeNull();
	expect(screen.getByRole('link', { name: /Get a key/ }).getAttribute('href')).toBe('https://openrouter.ai/keys');
	fireEvent.click(screen.getByRole('button', { name: 'All providers' }));
	fireEvent.click(screen.getByRole('button', { name: /^Ollama/ }));
	expect((screen.getByLabelText('API key (optional)') as HTMLInputElement).required).toBe(false);
	fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
	await waitFor(() => expect(saved).toHaveBeenCalledWith('ollama/qwen3'));
	expect(posts).toEqual([{ url: 'http://localhost/api/providers', body: { preset: 'ollama', url: '', protocol: 'chat', key: '', model: '' } }]);
	expect(screen.getByRole('status').textContent).toContain('now use ollama/qwen3');
});

it('lists connected providers first, marking the default, and opens one to replace its key', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ default: 'deepseek/deepseek-chat', providers: [{ id: 'openai', key: 'sk-…a1b2' }, { id: 'deepseek', key: 'sk-…c3d4' }] })));
	render(<ModelProvider connection={{ url: 'http://localhost', token: 't' }} open onOpenChange={() => {}} />);
	const connected = await screen.findByRole('region', { name: 'Connected' });
	const rows = within(connected).getAllByRole('button');
	expect(rows.map((r) => r.querySelector('.provider-text')!.textContent)).toEqual(['OpenAIsk-…a1b2', 'DeepSeeksk-…c3d4 · deepseek-chat']);
	expect(within(rows[1]).getByText('Default')).toBeDefined();
	expect(within(rows[0]).queryByText('Default')).toBeNull();
	fireEvent.click(rows[1]);
	expect(screen.getByRole('heading', { name: 'DeepSeek' })).toBeDefined();
	expect(screen.getByLabelText('API key').getAttribute('placeholder')).toContain('sk-…c3d4');
});

it('replaces the key of a connected custom API at its own endpoint', async () => {
	const posts: unknown[] = [];
	vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
		if (init?.method === 'POST') {
			posts.push(JSON.parse(String(init.body)));
			return Response.json({ default: 'custom/m1', models: 1 });
		}
		return Response.json({ default: 'custom/m1', providers: [{ id: 'custom', name: 'Custom', key: 'sk-…9z', anthropic: 'https://llm.example.com' }] });
	}));
	render(<ModelProvider connection={{ url: 'http://localhost', token: 't' }} open onOpenChange={() => {}} />);
	const connected = await screen.findByRole('region', { name: 'Connected' });
	fireEvent.click(within(connected).getByRole('button'));
	expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe('https://llm.example.com');
	expect(screen.getByRole('button', { name: 'Anthropic Messages' }).getAttribute('aria-pressed')).toBe('true');
	expect(screen.getByLabelText('API key').getAttribute('placeholder')).toContain('sk-…9z');
	fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-new' } });
	fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
	await screen.findByRole('status');
	expect(posts).toEqual([{ preset: '', url: 'https://llm.example.com', protocol: 'anthropic', key: 'sk-new', model: '' }]);
});

it('signs in with OpenRouter in the browser, or takes a pasted key', () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ default: '', providers: [] })));
	render(<ModelProvider connection={{ url: '', token: '', browser: true } as never} open onOpenChange={() => {}} />);
	expect(screen.getByRole('region', { name: 'Free to start' })).toBeDefined();
	fireEvent.click(screen.getByRole('button', { name: /^OpenRouter/ }));
	expect(screen.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeDefined();
	expect(screen.getByRole('button', { name: 'Connect with this key' })).toBeDefined();
	expect(screen.getByText(/Kept in this browser only/)).toBeDefined();
});

it('offers Workers AI of the signed-in Cloudflare account only in the browser', () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ default: '', providers: [] })));
	render(<ModelProvider connection={{ url: '', token: '', browser: true } as never} open onOpenChange={() => {}} />);
	fireEvent.click(screen.getByRole('button', { name: /^Workers AI/ }));
	expect(screen.getByRole('button', { name: 'Use my Cloudflare account' })).toBeDefined();
	expect(screen.queryByLabelText('API key')).toBeNull();
});

it('downloads Chrome’s built-in model before it saves it, only where Chrome has one', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ default: '', providers: [] })));
	const { unmount } = render(<ModelProvider connection={{ url: '', token: '', browser: true } as never} open onOpenChange={() => {}} />);
	expect(screen.queryByRole('button', { name: /Chrome built-in/ })).toBeNull();
	unmount();
	const create = vi.fn(async (options: { monitor?: (m: { addEventListener: (t: string, l: (e: { loaded: number }) => void) => void }) => void }) => {
		options.monitor?.({ addEventListener: (_t, l) => l({ loaded: 1 }) });
		return { destroy: () => {} };
	});
	vi.stubGlobal('LanguageModel', { availability: async () => 'downloadable', create });
	render(<ModelProvider connection={{ url: '', token: '', browser: true } as never} open onOpenChange={() => {}} />);
	fireEvent.click(screen.getByRole('button', { name: /^Chrome built-in/ }));
	expect(screen.queryByLabelText('API key')).toBeNull();
	expect(screen.queryByLabelText('Model ID (optional)')).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Download and use' }));
	// The save then goes to the browser runner, which only the public web build has.
	expect((await screen.findByRole('alert')).textContent).toContain('no browser runner');
	expect(create).toHaveBeenCalledOnce();
});

it('says so when this device cannot run Chrome’s model', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ default: '', providers: [] })));
	vi.stubGlobal('LanguageModel', { availability: async () => 'unavailable', create: vi.fn() });
	render(<ModelProvider connection={{ url: '', token: '', browser: true } as never} open onOpenChange={() => {}} />);
	fireEvent.click(screen.getByRole('button', { name: /^Chrome built-in/ }));
	fireEvent.click(screen.getByRole('button', { name: 'Download and use' }));
	expect((await screen.findByRole('alert')).textContent).toContain('cannot run its built-in model');
});
