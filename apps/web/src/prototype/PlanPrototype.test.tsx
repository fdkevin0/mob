import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlanPrototype } from './PlanPrototype';

afterEach(() => vi.useRealTimers());

it('approves the sample plan with the changes made in it, then shows its tasks move', async () => {
	vi.useFakeTimers();
	render(<PlanPrototype search="?flow=2.ready" />);
	const flow = screen.getByRole('dialog');
	fireEvent.click(within(flow).getByRole('button', { name: /Add a review/ }));
	fireEvent.click(within(flow).getByRole('button', { name: 'Approve with 1 change' }));
	await act(() => vi.advanceTimersByTimeAsync(30_000));
	fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
	const rows = screen.getAllByRole('listitem');
	expect(within(rows[2]).getByText('claude · checks, then review · mob/coupon-docs')).toBeTruthy();
	expect(within(rows[2]).getByRole('button', { name: /Ready/ })).toBeTruthy();
	// Start over asks again.
	fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
	expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
});
