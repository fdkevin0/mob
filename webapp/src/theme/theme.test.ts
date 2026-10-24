import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, saveTheme, storedTheme } from './theme';

const root = path.resolve(__dirname, '../..');
const inline = (file: string) => {
	const html = readFileSync(path.join(root, file), 'utf8');
	const scripts = [...html.matchAll(/<script>([^<]*)<\/script>/g)].map((m) => m[1]);
	expect(scripts).toHaveLength(1);
	return scripts[0];
};

function prefersLight(light: boolean) {
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: light && query.includes('light'), addEventListener() {}, removeEventListener() {} }));
}

afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
});

describe('theme', () => {
	it('runs the same boot script on every page, and the Worker allows it by hash', () => {
		const boot = inline('index.html');
		for (const page of ['account.html', 'landing.html', 'demo.html']) expect(inline(page)).toBe(boot);
		const hash = createHash('sha256').update(boot).digest('base64');
		expect(readFileSync(path.join(root, '../worker/index.ts'), 'utf8')).toContain(`'sha256-${hash}'`);
	});

	it('follows the system until light or dark is picked', () => {
		prefersLight(true);
		expect(storedTheme()).toBe('system');
		applyTheme('system');
		expect(document.documentElement.dataset.theme).toBe('light');
		expect(document.documentElement.classList.contains('dark')).toBe(false);
		saveTheme('dark');
		expect(storedTheme()).toBe('dark');
		expect(document.documentElement.dataset.theme).toBe('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		saveTheme('system');
		expect(localStorage.getItem('starlight-theme')).toBeNull();
		expect(document.documentElement.dataset.theme).toBe('light');
	});

	it('boot script agrees with applyTheme', () => {
		const boot = inline('index.html');
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
});
