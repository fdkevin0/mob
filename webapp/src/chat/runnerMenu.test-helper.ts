import { fireEvent, screen } from '@testing-library/react';

/** chooseFromRunnerMenu opens the sidebar's runner menu and picks the item named name. */
export async function chooseFromRunnerMenu(name: string | RegExp) {
	const trigger = screen.getAllByRole('button', { name: /settings and runner/ })[0];
	fireEvent.keyDown(trigger, { key: 'Enter' });
	fireEvent.click(await screen.findByRole('menuitem', { name }));
}
