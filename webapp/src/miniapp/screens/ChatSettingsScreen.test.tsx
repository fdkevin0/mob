import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatSettingsScreen } from './ChatSettingsScreen';
import { api } from '../api';

vi.mock('../api', async (importOriginal) => ({
	...await importOriginal<typeof import('../api')>(),
	api: { chatSettingsData: vi.fn(), setChatCompaction: vi.fn(), setChatMemoryTopK: vi.fn(), setChatReasoning: vi.fn() },
}));
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.chatSettingsData).mockResolvedValue({ reasoningEffort: 'default', compactionThreshold: 100000, memoryTopK: 5 });
});

it('saves a numeric threshold via form submission and reflects the server value', async () => {
	vi.mocked(api.setChatCompaction).mockResolvedValue({ ok: true, compactionThreshold: 60000 });
	render(<ChatSettingsScreen />);
	const input = await screen.findByRole('spinbutton', { name: 'Compaction threshold' }) as HTMLInputElement;
	fireEvent.change(input, { target: { value: '50000' } });
	fireEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
	await waitFor(() => expect(input.value).toBe('60000'));
	expect(api.setChatCompaction).toHaveBeenCalledWith(50000);
	await screen.findByRole('status', { name: 'Threshold saved' });
});

it('keeps blank-to-default semantics for memory count and prevents duplicate saves', async () => {
	let resolveSave!: (value: { ok: true; memoryTopK: number }) => void;
	vi.mocked(api.setChatMemoryTopK).mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
	render(<ChatSettingsScreen />);
	const input = await screen.findByRole('spinbutton', { name: 'Memory retrieval count' }) as HTMLInputElement;
	fireEvent.change(input, { target: { value: '' } });
	fireEvent.click(screen.getByRole('button', { name: 'Save retrieval count' }));
	expect(api.setChatMemoryTopK).toHaveBeenCalledWith(null);
	expect(input.disabled).toBe(true);
	fireEvent.submit(input.form!);
	expect(api.setChatMemoryTopK).toHaveBeenCalledTimes(1);
	resolveSave({ ok: true, memoryTopK: 5 });
	await waitFor(() => expect(input.disabled).toBe(false));
	expect(input.value).toBe('5');
});

it('leaves input editable after a rejected save', async () => {
	vi.mocked(api.setChatCompaction).mockRejectedValue(new Error('failed'));
	render(<ChatSettingsScreen />);
	const input = await screen.findByRole('spinbutton', { name: 'Compaction threshold' }) as HTMLInputElement;
	fireEvent.submit(input.form!);
	await screen.findByRole('status', { name: 'Could not save threshold' });
	expect(input.disabled).toBe(false);
});

it.each([
	['Compaction threshold', 'Save threshold'],
	['Memory retrieval count', 'Save retrieval count'],
])('blocks invalid %s values through native form validation', async (label, button) => {
	render(<ChatSettingsScreen />);
	const input = await screen.findByRole('spinbutton', { name: label });
	for (const value of ['0', '-1', '1.5']) {
		fireEvent.change(input, { target: { value } });
		fireEvent.click(screen.getByRole('button', { name: button }));
	}
	expect(api.setChatCompaction).not.toHaveBeenCalled();
	expect(api.setChatMemoryTopK).not.toHaveBeenCalled();
});
