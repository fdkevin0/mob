import { Dialog } from '../components/ui/dialog';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelPicker } from './ModelPicker';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const connection = { url: 'http://localhost', token: 'token' };

const models = [
	{
		provider: 'deepseek',
		name: 'DeepSeek',
		models: [
			{ id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', tools: true, context: 131072 },
			{ id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner', tools: true, reasoning: true, context: 65536 },
		],
	},
	{
		provider: 'opencode',
		name: 'OpenCode Zen',
		models: [{ id: 'opencode/mimo-v2.6-flash-free', tools: true, context: 262144 }],
	},
];

it('offers every provider, filters by query and reports the chosen model', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	const picked = vi.fn();
	render(<Dialog defaultOpen><ModelPicker connection={connection} defaultModel="opencode/mimo-v2.6-flash-free" onPick={picked} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	expect(screen.getByText('deepseek/deepseek-reasoner')).toBeDefined();
	expect(screen.getByText(/131k context/)).toBeDefined();
	fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'reasoner' } });
	expect(screen.queryByText('DeepSeek Chat')).toBeNull();
	fireEvent.click(screen.getByText('DeepSeek Reasoner'));
	expect(picked).toHaveBeenCalledWith('deepseek/deepseek-reasoner');
});

it('offers the default and marks the current model', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	const picked = vi.fn();
	render(<Dialog defaultOpen><ModelPicker connection={connection} current="deepseek/deepseek-chat" defaultModel="opencode/mimo-v2.6-flash-free" onPick={picked} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	const current = screen.getByText('DeepSeek Chat').closest('button');
	expect(current?.getAttribute('aria-current')).toBe('true');
	fireEvent.click(screen.getByText(/Follow the default/));
	expect(picked).toHaveBeenCalledWith(undefined);
});

it('surfaces a model list failure instead of an empty picker', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'provider list unavailable' }, { status: 500 })));
	render(<Dialog defaultOpen><ModelPicker connection={connection} onPick={() => {}} /></Dialog>);
	await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('provider list unavailable'));
});

it('marks free models and shows only them when asked', async () => {
	const withFree = [...models, { provider: 'openrouter', name: 'OpenRouter', models: [{ id: 'meta/llama:free', tools: true, free: true }, { id: 'openai/gpt-x', tools: true }] }];
	withFree[1] = { ...withFree[1], models: [{ ...withFree[1].models[0], free: true }] };
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(withFree)));
	render(<Dialog defaultOpen><ModelPicker connection={connection} onPick={() => {}} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	expect(screen.getAllByText('Free')).toHaveLength(2);
	const filter = screen.getByRole('button', { name: 'Free only (2)' });
	fireEvent.click(filter);
	expect(filter.getAttribute('aria-pressed')).toBe('true');
	expect(screen.queryByText('DeepSeek Chat')).toBeNull();
	expect(screen.queryByText('openai/gpt-x')).toBeNull();
	expect(screen.getByText('meta/llama:free', { selector: '.model-id' })).toBeDefined();
	fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'gpt' } });
	expect(screen.getByText('No free models match “gpt”.')).toBeDefined();
});
