import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
	authClient: { useSession: () => ({ isPending: false, data: null }) },
	keepOffer: () => false,
	pendingOffer: () => false,
	returnAfterSignIn: vi.fn(),
	loadSite: async () => ({ ready: false, turnstileSiteKey: '' }),
	openApp: vi.fn(),
}));
vi.mock('@mob/ui/voxel/VoxelCanvas', () => ({ VoxelCanvas: () => null }));

import { Landing } from './Landing';

it.each(['Get started', 'Log in'])('returns focus to %s after closing sign-in', async name => {
	render(<Landing />);
	const trigger = screen.getByRole('button', { name });
	fireEvent.click(trigger);
	const dialog = await screen.findByRole('dialog', { name: 'Sign in to Mob' });
	await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
	fireEvent.keyDown(dialog, { key: 'Escape' });
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	await waitFor(() => expect(document.activeElement).toBe(trigger));
});
