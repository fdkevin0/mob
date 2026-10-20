import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
	authClient: { useSession: () => ({ isPending: false, data: null }) },
	keepOffer: () => false,
	pendingOffer: () => false,
	loadSite: async () => ({ ready: false, turnstileSiteKey: '' }),
	openApp: vi.fn(),
}));
vi.mock('./voxel/VoxelCanvas', () => ({ VoxelCanvas: () => null }));

import { Landing } from './Landing';

it('returns focus to the button that opened sign-in from either part of the page', async () => {
	render(<Landing />);
	for (const name of ['Sign in', 'Get started']) {
		const trigger = screen.getByRole('button', { name });
		fireEvent.click(trigger);
		const dialog = await screen.findByRole('dialog', { name: 'Sign in to Mob' });
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
		fireEvent.keyDown(dialog, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	}
});
