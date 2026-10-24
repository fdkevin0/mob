import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

// The web app's page once had no icon, so its browser tab showed none: every page names the same calf files.
it('gives every page the calf as its tab and home screen icon', () => {
	const expected = [
		['icon', '/src/components/brand/favicon-32.png'],
		['icon', '/src/components/brand/favicon.svg'],
		['apple-touch-icon', '/src/components/brand/apple-touch-icon.png'],
	];
	for (const page of ['index.html', 'landing.html', 'account.html', 'demo.html']) {
		const html = readFileSync(path.join(root, page), 'utf8');
		const links = [...html.matchAll(/<link rel="((?:apple-touch-)?icon)"[^>]*href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
		expect(links, page).toEqual(expected);
	}
	for (const [, href] of expected) expect(existsSync(path.join(root, href)), href).toBe(true);
});
