import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GlobalServiceScreen } from './GlobalServiceScreen';
import { api } from '../api';

vi.mock('../api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../api')>();
	return {
		...actual,
		api: {
			globalServiceData: vi.fn(),
			setEmailHtmlParser: vi.fn(),
		},
	};
});

const baseData = { emailHtmlParser: 'turndown' as const };

beforeEach(() => {
	vi.mocked(api.globalServiceData).mockReset();
	vi.mocked(api.setEmailHtmlParser).mockReset();
});

describe('GlobalServiceScreen — Email HTML converter (ADR-0045)', () => {
	it('renders the Email HTML converter section with the current value', async () => {
		vi.mocked(api.globalServiceData).mockResolvedValue({ ...baseData, emailHtmlParser: 'turndown' });
		render(<GlobalServiceScreen />);
		await screen.findByLabelText('HTML conversion');
		const select = screen.getByDisplayValue('Standard (free)') as HTMLSelectElement;
		expect(select.tagName).toBe('SELECT');
	});

	it('calls api.setEmailHtmlParser("ai") when the admin switches to ai', async () => {
		vi.mocked(api.globalServiceData).mockResolvedValue({ ...baseData, emailHtmlParser: 'turndown' });
		vi.mocked(api.setEmailHtmlParser).mockResolvedValue({ ok: true, emailHtmlParser: 'ai' });

		render(<GlobalServiceScreen />);
		await screen.findByLabelText('HTML conversion');

		const select = screen.getByDisplayValue('Standard (free)') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'ai' } });

		await waitFor(() => expect(vi.mocked(api.setEmailHtmlParser)).toHaveBeenCalledWith('ai'));
	});

	it('shows a status error when setEmailHtmlParser fails', async () => {
		vi.mocked(api.globalServiceData).mockResolvedValue({ ...baseData });
		vi.mocked(api.setEmailHtmlParser).mockRejectedValue(new Error('boom'));

		render(<GlobalServiceScreen />);
		await screen.findByLabelText('HTML conversion');

		const select = screen.getByDisplayValue('Standard (free)') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'ai' } });

		await screen.findByRole('status', { name: 'Could not save email processing' });
	});
});
