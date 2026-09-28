import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EmailDetailScreen } from './EmailDetailScreen';
import { api } from '../api';

vi.mock('../api', () => ({
	api: { getEmail: vi.fn() },
}));

const baseEmail = { subject: 'Hi', from: 'a@b.com', to: 'c@d.com', date: '2026-07-05', attachments: [], spam: false, auth: null };

beforeEach(() => {
	vi.mocked(api.getEmail).mockReset();
});

describe('EmailDetailScreen render-mode', () => {
	it('renders a sandboxed iframe when html is present', async () => {
		vi.mocked(api.getEmail).mockResolvedValue({ email: { ...baseEmail, html: '<b>hi</b>', text: null } });
		const { container } = render(<EmailDetailScreen id={1} />);
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		const iframe = container.querySelector('iframe')!;
		expect(iframe.getAttribute('sandbox')).toBe('');
		expect(container.querySelector('pre')).toBeNull();
	});

	it('renders a <pre> when only text is present', async () => {
		vi.mocked(api.getEmail).mockResolvedValue({ email: { ...baseEmail, html: null, text: 'plain body' } });
		render(<EmailDetailScreen id={2} />);
		await screen.findByText('plain body');
	});

	it('renders a placeholder when neither html nor text is present', async () => {
		vi.mocked(api.getEmail).mockResolvedValue({ email: { ...baseEmail, html: null, text: null } });
		render(<EmailDetailScreen id={3} />);
		await screen.findByText('This email has no viewable body.');
	});

	it('shows a status line on fetch failure', async () => {
		vi.mocked(api.getEmail).mockRejectedValue(new Error('nope'));
		render(<EmailDetailScreen id={4} />);
		await screen.findByText('Could not load email');
	});

	it('shows a SPAM badge and auth line when flagged', async () => {
		vi.mocked(api.getEmail).mockResolvedValue({
			email: { ...baseEmail, html: null, text: 'x', spam: true, auth: { spf: 'fail', dkim: 'none', dmarc: 'fail' } },
		});
		const { container } = render(<EmailDetailScreen id={5} />);
		await screen.findByText('SPAM');
		await waitFor(() =>
			expect(container.querySelector('#email-detail-auth')?.textContent).toBe('SPF fail · DKIM none · DMARC fail')
		);
	});
});
