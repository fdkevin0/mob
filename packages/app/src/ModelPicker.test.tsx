import { Dialog, DialogTrigger } from '@mob/ui/dialog';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelPicker, families, recentModels, refOf, withoutEffort } from './ModelPicker';

afterEach(() => {
	cleanup();
	localStorage.clear();
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
	expect(screen.getByRole('button', { name: 'DeepSeek Chat' }).textContent).toContain('131k');
	expect(screen.getByRole('button', { name: 'opencode/mimo-v2.6-flash-free' })).toBeDefined();
	fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'reasoner' } });
	expect(screen.queryByText('DeepSeek Chat')).toBeNull();
	fireEvent.click(screen.getByText('DeepSeek Reasoner'));
	expect(picked).toHaveBeenCalledWith('deepseek/deepseek-reasoner');
	expect(recentModels()).toEqual(['deepseek/deepseek-reasoner']);
});

it('names a provider’s model as provider/model, whether or not the provider lists the prefix', () => {
	expect(refOf('openai', { id: 'gpt-5', tools: true })).toBe('openai/gpt-5');
	expect(refOf('deepseek', { id: 'deepseek/deepseek-chat', tools: true })).toBe('deepseek/deepseek-chat');
	expect(withoutEffort('openai/o3:high')).toBe('openai/o3');
	expect(withoutEffort('openrouter/meta/llama:free')).toBe('openrouter/meta/llama:free');
});

it('offers the default and marks the current model', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	const picked = vi.fn();
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="deepseek/deepseek-chat" defaultModel="opencode/mimo-v2.6-flash-free" onPick={picked} /></Dialog>);
	const current = await screen.findByRole('button', { name: 'DeepSeek Chat' });
	expect(current.getAttribute('aria-current')).toBe('true');
	// The card beside the list tells about the current model until another is pointed at.
	expect(screen.getByRole('complementary', { name: 'About DeepSeek Chat' }).textContent).toContain('131,072');
	fireEvent.mouseEnter(screen.getByRole('button', { name: 'DeepSeek Reasoner' }));
	expect(screen.getByRole('complementary', { name: 'About DeepSeek Reasoner' }).textContent).toContain('deepseek/deepseek-reasoner');
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
	expect(document.querySelectorAll('.model-free')).toHaveLength(2);
	const filter = screen.getByRole('button', { name: 'Free' });
	fireEvent.click(filter);
	expect(filter.getAttribute('aria-pressed')).toBe('true');
	expect(screen.queryByText('DeepSeek Chat')).toBeNull();
	expect(screen.queryByText('openai/gpt-x')).toBeNull();
	expect(screen.getByRole('button', { name: 'meta/llama:free' })).toBeDefined();
	expect(screen.queryByText(/Follow the default/)).toBeNull();
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
	fireEvent.click(screen.getByRole('button', { name: 'Free' }));
	expect(screen.getByRole('alert').textContent).toBe('Cannot load models');
	expect(screen.queryByText(/No .*models match/)).toBeNull();
});

it('lists recent choices first and keeps them in this browser only', async () => {
	localStorage.setItem('mob-recent-models', JSON.stringify(['deepseek/deepseek-reasoner', 'gone/model']));
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} onPick={() => {}} /></Dialog>);
	const recent = await screen.findByRole('region', { name: 'Recent' });
	expect([...recent.querySelectorAll('.model-choice')].map((b) => b.getAttribute('aria-label'))).toEqual(['DeepSeek Reasoner']);
	fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'deep' } });
	expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull();
});

it('chooses the current model’s reasoning level and makes it the default', async () => {
	const withEfforts = [{ provider: 'openai', name: 'OpenAI', models: [{ id: 'o3', name: 'o3', tools: true, reasoning: true, efforts: ['low', 'high'] }, { id: 'gpt-5', tools: true }] }];
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(withEfforts)));
	const picked = vi.fn();
	const setDefault = vi.fn();
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="openai/o3:low" defaultModel="openai/gpt-5" onPick={picked} setDefault={setDefault} /></Dialog>);
	const levels = await screen.findByRole('group', { name: 'Reasoning' });
	expect(screen.getByRole('button', { name: 'o3' }).getAttribute('aria-current')).toBe('true');
	expect(screen.getByRole('button', { name: 'low' }).getAttribute('aria-pressed')).toBe('true');
	fireEvent.click(screen.getByRole('button', { name: 'high' }));
	expect(picked).toHaveBeenLastCalledWith('openai/o3:high');
	fireEvent.click(levels.querySelector('button')!);
	expect(picked).toHaveBeenLastCalledWith('openai/o3');
	expect(recentModels()).toEqual(['openai/o3']);
	fireEvent.click(screen.getByRole('button', { name: 'Make o3 low the default' }));
	expect(setDefault).toHaveBeenCalledWith('openai/o3:low');
});

it('offers to make the current reasoning level the default when only the level differs', async () => {
	const withEfforts = [{ provider: 'openai', name: 'OpenAI', models: [{ id: 'o3', name: 'o3', tools: true, reasoning: true, efforts: ['low', 'high'] }] }];
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(withEfforts)));
	const { rerender } = render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="openai/o3:high" defaultModel="openai/o3:low" onPick={() => {}} setDefault={() => {}} /></Dialog>);
	expect(await screen.findByRole('button', { name: 'Make o3 high the default' })).toBeDefined();
	rerender(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="openai/o3" defaultModel="openai/o3:low" onPick={() => {}} setDefault={() => {}} /></Dialog>);
	expect(screen.getByRole('button', { name: 'Make o3 the default' })).toBeDefined();
	rerender(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="openai/o3:low" defaultModel="openai/o3:low" onPick={() => {}} setDefault={() => {}} /></Dialog>);
	expect(screen.getByText('Default: o3 low')).toBeDefined();
	expect(screen.queryByRole('button', { name: /the default$/ })).toBeNull();
});

it('says which model is the default when the current one already is', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(models)));
	render(<Dialog modal={false} defaultOpen><ModelPicker connection={connection} current="deepseek/deepseek-chat" defaultModel="deepseek/deepseek-chat" onPick={() => {}} setDefault={() => {}} /></Dialog>);
	expect(await screen.findByText('Default: DeepSeek Chat')).toBeDefined();
	expect(screen.queryByRole('button', { name: /the default$/ })).toBeNull();
	expect(screen.queryByRole('group', { name: 'Reasoning' })).toBeNull();
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
