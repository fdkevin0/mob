import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SiteHeader } from '../components/site/Site';

it.each(['/', '/demo', '/docs/', '/account'])('keeps the same public navigation on %s', current => {
	render(<SiteHeader current={current} />);
	const nav = within(screen.getByRole('navigation', { name: 'Site' }));
	expect(nav.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
		['Home', '/'], ['Demo', '/demo'], ['Docs', '/docs/'], ['GitHub', 'https://github.com/fdkevin0/mob'],
	]);
	expect(screen.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/account');
	expect(screen.getByRole('link', { name: 'Open Mob' }).getAttribute('href')).toBe('/app');
	expect(screen.getByRole('link', { current: 'page' }).getAttribute('href')).toBe(current);
	expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
});
