import { Dialog, DialogTrigger } from '../components/ui/dialog';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelPicker, families } from './ModelPicker';

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
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} defaultModel="opencode/mimo-v2.6-flash-free" onPick={picked} /></Dialog>);
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
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="deepseek/deepseek-chat" defaultModel="opencode/mimo-v2.6-flash-free" onPick={picked} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	const current = screen.getByText('DeepSeek Chat').closest('button');
	expect(current?.getAttribute('aria-current')).toBe('true');
	fireEvent.click(screen.getByText(/Follow the default/));
	expect(picked).toHaveBeenCalledWith(undefined);
});

it('surfaces a model list failure instead of an empty picker', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'provider list unavailable' }, { status: 500 })));
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={() => {}} /></Dialog>);
	await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('provider list unavailable'));
});

it('marks free models and shows only them when asked', async () => {
	const withFree = [...models, { provider: 'openrouter', name: 'OpenRouter', models: [{ id: 'meta/llama:free', tools: true, free: true }, { id: 'openai/gpt-x', tools: true }] }];
	withFree[1] = { ...withFree[1], models: [{ ...withFree[1].models[0], free: true }] };
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(withFree)));
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={() => {}} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	expect(screen.getAllByText('Free')).toHaveLength(2);
	fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
	const filter = screen.getByRole('checkbox', { name: 'Free only' });
	fireEvent.click(filter);
	expect((filter as HTMLInputElement).checked).toBe(true);
	expect(screen.queryByText('DeepSeek Chat')).toBeNull();
	expect(screen.queryByText('openai/gpt-x')).toBeNull();
	expect(screen.getByText('meta/llama:free', { selector: '.model-id' })).toBeDefined();
	fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'gpt' } });
	expect(screen.getByText('No free models match “gpt”.')).toBeDefined();
});

it('groups a provider’s models by vendor prefix and narrows to one provider', async () => {
	const many = Array.from({ length: 14 }, (_, i) => ({ id: `openrouter/${i % 2 ? 'anthropic' : 'meta'}/m${i}`, tools: true }));
	vi.stubGlobal('fetch', vi.fn(async () => Response.json([...models, { provider: 'openrouter', name: 'OpenRouter', models: [{ id: 'openrouter/openrouter/auto', tools: true }, ...many] }])));
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="openrouter/meta/m2" onPick={() => {}} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	const anthropic = screen.getByText('anthropic').closest('details')!;
	expect(anthropic.open).toBe(false);
	expect(screen.getByText('meta').closest('details')!.open).toBe(true);
	fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
	fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openrouter' } });
	expect(screen.queryByText('DeepSeek Chat')).toBeNull();
	fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'm1' } });
	expect(screen.getByRole('button', { name: 'openrouter/anthropic/m1' })).toBeDefined();
});

it('puts models without a vendor prefix first', () => {
	const f = families('openrouter', [{ id: 'openrouter/z/a', tools: true }, { id: 'openrouter/b', tools: true }, { id: 'openrouter/a/c', tools: true }]);
	expect(f.map(x => x.prefix)).toEqual(['', 'a', 'z']);
	expect(families('deepseek', [{ id: 'deepseek/deepseek-chat', tools: true }]).map(x => x.prefix)).toEqual(['']);
});

it('keeps provider failures visible through search and free filters', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ provider: 'broken', name: 'Broken provider', models: [], error: 'Cannot load models' }])));
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={() => {}} /></Dialog>);
	await screen.findByRole('alert');
	fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'missing' } });
	fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
	fireEvent.click(screen.getByLabelText('Free only'));
	expect(screen.getByRole('alert').textContent).toBe('Cannot load models');
	expect(screen.queryByText(/No .*models match/)).toBeNull();
});

it('disables choices and explains why when a turn becomes busy with the picker open', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	const picked = vi.fn();
	const { rerender } = render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={picked} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	rerender(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={picked} disabled /></Dialog>);
	expect(screen.getByRole('status').textContent).toContain('Wait for the current turn');
	for (const button of document.querySelectorAll<HTMLButtonElement>('.model-choice')) {
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
	}
	expect(picked).not.toHaveBeenCalled();
});

it('dismisses without blocking the composer and never submits it while filtering', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	const submitted = vi.fn(event => event.preventDefault());
	render(
		<form onSubmit={submitted}>
			<input aria-label="Message" />
			<Dialog modal={false}>
				<DialogTrigger type="button">Choose model</DialogTrigger>
				<ModelPicker connection={connection} onPick={() => {}} />
			</Dialog>
		</form>,
	);
	const trigger = screen.getByRole('button', { name: 'Choose model' });
	fireEvent.click(trigger);
	await screen.findByText('DeepSeek Chat');
	expect(screen.getByRole('dialog').getAttribute('aria-modal')).not.toBe('true');
	expect(document.querySelector('.dialog-overlay')).toBeNull();
	for (const button of screen.getByRole('dialog').querySelectorAll('button')) {
		expect(button.type).toBe('button');
	}
	fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
	fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'deepseek' } });
	expect(fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Enter' })).toBe(false);
	expect(submitted).not.toHaveBeenCalled();
	fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' });
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	await waitFor(() => expect(document.activeElement).toBe(trigger));
	fireEvent.click(trigger);
	await screen.findByRole('dialog');
	screen.getByLabelText('Message').focus();
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	expect(document.activeElement).toBe(screen.getByLabelText('Message'));
});


it('navigates choices with arrows and selects a search result with Enter, except during IME composition', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	const picked = vi.fn();
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={picked} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	const search = screen.getByLabelText('Search models');
	fireEvent.keyDown(search, { key: 'ArrowDown' });
	expect(document.activeElement?.textContent).toContain('Follow the default');
	fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
	expect(document.activeElement?.textContent).toContain('DeepSeek Chat');
	fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
	expect(document.activeElement?.textContent).toContain('Follow the default');
	fireEvent.change(search, { target: { value: 'reasoner' } });
	fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
	expect(picked).not.toHaveBeenCalled();
	fireEvent.keyDown(search, { key: 'Enter' });
	expect(picked).toHaveBeenCalledWith('deepseek/deepseek-reasoner');
	fireEvent.change(search, { target: { value: 'missing' } });
	picked.mockClear();
	fireEvent.keyDown(search, { key: 'Enter' });
	expect(picked).not.toHaveBeenCalled();
});

it('keeps model details available through an accessible disclosure', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={() => {}} /></Dialog>);
	await screen.findByText('DeepSeek Chat');
	const summary = screen.getByLabelText('Details for DeepSeek Chat');
	const details = summary.closest('details')!;
	expect(details.open).toBe(false);
	fireEvent.click(summary);
	expect(details.open).toBe(true);
	expect(details.textContent).toContain('131k context');
});

it('selects the first expanded search result and does nothing when all result groups are collapsed', async () => {
	const many = Array.from({ length: 14 }, (_, i) => ({ id: `openrouter/${i < 7 ? 'alpha' : 'beta'}/model-${i}`, name: `Model ${i}`, tools: true }));
	vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ provider: 'openrouter', name: 'OpenRouter', models: many }])));
	const picked = vi.fn();
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={picked} /></Dialog>);
	await screen.findByText('Model 0');
	const search = screen.getByLabelText('Search models');
	fireEvent.change(search, { target: { value: 'model' } });
	fireEvent.click(screen.getByText('alpha'));
	expect(screen.getByText('alpha').closest('details')!.open).toBe(false);
	fireEvent.keyDown(search, { key: 'Enter' });
	expect(picked).toHaveBeenCalledExactlyOnceWith('openrouter/beta/model-7');
	picked.mockClear();
	fireEvent.click(screen.getByText('beta'));
	expect(screen.getByText('beta').closest('details')!.open).toBe(false);
	fireEvent.keyDown(search, { key: 'Enter' });
	expect(picked).not.toHaveBeenCalled();
});

it('offers to add a model provider, first of all when none is set up', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
	const add = vi.fn();
	render(<Dialog defaultOpen><ModelPicker connection={connection} onPick={() => {}} addProvider={add} /></Dialog>);
	await screen.findByText('No model provider is set up yet. Add one to choose from its models.');
	fireEvent.click(screen.getByRole('button', { name: 'Add a model provider' }));
	expect(add).toHaveBeenCalled();
});
