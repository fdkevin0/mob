import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ApprovalPrompt } from './ApprovalPrompt';

it('shows the entire request and allows once without remembering', () => {
	const decide = vi.fn();
	const request = JSON.stringify({ command: 'x'.repeat(10000), path: '/project', target: 'preview' });
	render(<ApprovalPrompt question="Allow command?" request={request} busy={false} decide={decide} />);
	expect(screen.getByText(request).closest('details')?.open).toBe(true);
	expect(screen.queryByRole('menuitem')).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
	expect(decide).toHaveBeenCalledWith(true);
});

it.each(['conversation', 'always'] as const)('submits exactly the selected %s grant', async scope => {
	const decide = vi.fn();
	render(<ApprovalPrompt question="Allow command?" request="npm test" busy={false} decide={decide} />);
	fireEvent.keyDown(screen.getByRole('button', { name: 'More permissions…' }), { key: 'Enter' });
	fireEvent.click(await screen.findByRole('menuitem', { name: scope === 'conversation' ? 'Allow in this conversation' : 'Always allow across conversations' }));
	expect(decide).toHaveBeenCalledExactlyOnceWith(true, undefined, scope);
});

it('keeps partial requests unapprovable and supports a denial reason', () => {
	const decide = vi.fn();
	render(<ApprovalPrompt question="Allow command?" request="partial" whole={false} busy={false} decide={decide} />);
	expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
	expect(screen.queryByRole('button', { name: 'More permissions…' })).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Deny…' }));
	fireEvent.change(screen.getByLabelText('Reason for denying (optional)'), { target: { value: ' wrong target ' } });
	fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
	expect(decide).toHaveBeenCalledWith(false, 'wrong target');
});

it('disables decisions while submitting and preserves the reason for a retry', () => {
	const decide = vi.fn();
	const props = { question: 'Allow?', request: 'request', decide };
	const { rerender } = render(<ApprovalPrompt {...props} busy={false} />);
	fireEvent.click(screen.getByRole('button', { name: 'Deny…' }));
	const input = screen.getByLabelText('Reason for denying (optional)') as HTMLInputElement;
	fireEvent.change(input, { target: { value: 'keep this reason' } });
	rerender(<ApprovalPrompt {...props} busy />);
	expect(input.disabled).toBe(true);
	expect(screen.getByRole('status').textContent).toBe('Submitting decision…');
	fireEvent.submit(input.closest('form')!);
	expect(decide).not.toHaveBeenCalled();
	rerender(<ApprovalPrompt {...props} busy={false} />);
	expect(input.value).toBe('keep this reason');
});
