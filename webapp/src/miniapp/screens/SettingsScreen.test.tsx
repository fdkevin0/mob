import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsScreen } from './SettingsScreen';
import { api } from '../api';

vi.mock('../api', () => ({ api: { setDebug: vi.fn(), setLanguage: vi.fn() } }));

function Settings({ canDebug = true }: { canDebug?: boolean }) {
	const [debug, setDebug] = useState(false);
	return <SettingsScreen capabilities={canDebug ? ['view_debug'] : []} language={null} debug={debug}
		onDebugChange={setDebug} onLanguageChange={vi.fn()} onSchedulesChange={vi.fn()}
		onOpenChatSettings={vi.fn()} onOpenGlobalService={vi.fn()} />;
}

beforeEach(() => vi.resetAllMocks());

it('saves the checkbox value and reflects the stored state', async () => {
	vi.mocked(api.setDebug).mockResolvedValue({ ok: true, enabled: true });
	render(<Settings />);
	const checkbox = screen.getByRole('checkbox', { name: 'Debug mode' }) as HTMLInputElement;
	fireEvent.click(checkbox);
	await screen.findByRole('status', { name: 'Debug enabled' });
	expect(api.setDebug).toHaveBeenCalledWith(true);
	expect(checkbox.checked).toBe(true);
	vi.mocked(api.setDebug).mockResolvedValue({ ok: true, enabled: false });
	fireEvent.click(checkbox);
	await screen.findByRole('status', { name: 'Debug disabled' });
	expect(api.setDebug).toHaveBeenLastCalledWith(false);
	expect(checkbox.checked).toBe(false);
});

it('keeps the stored checkbox value when saving fails', async () => {
	vi.mocked(api.setDebug).mockRejectedValue(new Error('failed'));
	render(<Settings />);
	fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }));
	await screen.findByRole('status', { name: 'Could not save debug setting' });
	expect((screen.getByRole('checkbox', { name: 'Debug mode' }) as HTMLInputElement).checked).toBe(false);
});

it('omits Debug without the capability', () => {
	render(<Settings canDebug={false} />);
	expect(screen.queryByRole('checkbox')).toBeNull();
});

it('submits the labelled language form once and restores it after a failed save', async () => {
	let rejectSave!: (reason: Error) => void;
	vi.mocked(api.setLanguage).mockReturnValue(new Promise((_, reject) => { rejectSave = reject; }));
	render(<Settings />);
	const input = screen.getByRole('textbox', { name: 'Reply language' }) as HTMLInputElement;
	fireEvent.change(input, { target: { value: '中文' } });
	fireEvent.submit(input.form!);
	expect(api.setLanguage).toHaveBeenCalledWith('中文');
	expect((screen.getByRole('button', { name: 'Saving' }) as HTMLButtonElement).disabled).toBe(true);
	fireEvent.submit(input.form!);
	expect(api.setLanguage).toHaveBeenCalledTimes(1);
	rejectSave(new Error('failed'));
	await screen.findByRole('status', { name: 'Could not save language' });
	expect((screen.getByRole('button', { name: 'Save language' }) as HTMLButtonElement).disabled).toBe(false);
	expect(input.value).toBe('中文');
});

it('renders feedback in a visible toast outside the language form', async () => {
	vi.mocked(api.setDebug).mockResolvedValue({ ok: true, enabled: true });
	render(<Settings />);
	fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }));
	const message = await screen.findByRole('status');
	expect(message.textContent).toBe('Debug enabled');
	expect(message.closest('[aria-hidden="true"]')).toBeNull();
	expect(document.getElementById('miniapp-notification')?.textContent).toBe('Debug enabled');
	expect(message.closest('form, section')).toBeNull();
});
