import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// The site's pages, and the workspace page mob serves from @mob/app, share
// their head: one inline theme script and the calf icons.
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'node_modules/@mob/app');
const pages = [path.join(app, 'index.html'), ...['app.html', 'landing.html', 'account.html', 'demo.html'].map((page) => path.join(root, page))];
const inline = (file: string) => {
	const scripts = [...readFileSync(file, 'utf8').matchAll(/<script>([^<]*)<\/script>/g)].map((m) => m[1]);
	expect(scripts, file).toHaveLength(1);
	return scripts[0];
};

function prefersLight(light: boolean) {
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: light && query.includes('light'), addEventListener() {}, removeEventListener() {} }));
}

afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
});

it('runs the same boot script on every page, and the Worker allows it by hash', () => {
	const boot = inline(pages[0]);
	for (const page of pages) expect(inline(page), page).toBe(boot);
	const hash = createHash('sha256').update(boot).digest('base64');
	expect(readFileSync(path.join(root, 'worker/index.ts'), 'utf8')).toContain(`'sha256-${hash}'`);
});

it('boot script agrees with applyTheme', () => {
	const boot = inline(pages[0]);
	const meta = document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color', content: '#0c0d0f' }));
	for (const [saved, light, want] of [
		[null, false, 'dark'],
		[null, true, 'light'],
		['dark', true, 'dark'],
		['light', false, 'light'],
	] as const) {
		prefersLight(light);
		if (saved) localStorage.setItem('starlight-theme', saved);
		else localStorage.removeItem('starlight-theme');
		delete document.documentElement.dataset.theme;
		new Function(boot)();
		expect(document.documentElement.dataset.theme).toBe(want);
		expect(meta.content).toBe(want === 'light' ? '#f4f3ee' : '#0c0d0f');
		meta.content = '#0c0d0f';
	}
	meta.remove();
});

// The web app's page once had no icon, so its browser tab showed none: every page names the same calf files.
it('gives every page the calf as its tab and home screen icon', () => {
	const expected = [
		['icon', '/node_modules/@mob/ui/src/brand/favicon-32.png'],
		['icon', '/node_modules/@mob/ui/src/brand/favicon.svg'],
		['apple-touch-icon', '/node_modules/@mob/ui/src/brand/apple-touch-icon.png'],
	];
	for (const page of pages) {
		const links = [...readFileSync(page, 'utf8').matchAll(/<link rel="((?:apple-touch-)?icon)"[^>]*href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
		expect(links, page).toEqual(expected);
		for (const [, href] of expected) expect(existsSync(path.join(path.dirname(page), href)), `${page}: ${href}`).toBe(true);
	}
});
