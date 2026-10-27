import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, saveTheme, storedTheme } from './theme';

function prefersLight(light: boolean) {
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: light && query.includes('light'), addEventListener() {}, removeEventListener() {} }));
}

afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
});

describe('theme', () => {
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

});
