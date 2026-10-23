import { useSyncExternalStore } from 'react';

// The app and the account page follow the system colour scheme unless the
// viewer picked light or dark. The choice lives in this browser only; the
// inline script in index.html and account.html applies it before the first
// paint (worker/index.ts allows it by hash), and startTheme keeps the page in step afterwards.
export type Theme = 'system' | 'light' | 'dark';

export const themes: Theme[] = ['system', 'light', 'dark'];

const key = 'mob.theme';
const query = '(prefers-color-scheme: light)';
const colors = { light: '#f7f4ee', dark: '#131210' };

export function storedTheme(): Theme {
	try {
		const value = localStorage.getItem(key);
		if (value === 'light' || value === 'dark') return value;
	} catch {
		// Storage can be blocked; follow the system then.
	}
	return 'system';
}

function systemLight() {
	return typeof matchMedia === 'function' && matchMedia(query).matches;
}

export function applyTheme(theme: Theme) {
	const light = theme === 'light' || (theme === 'system' && systemLight());
	const root = document.documentElement;
	// Colours change at once rather than fading control by control.
	root.classList.add('theme-switch');
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switch')));
	root.dataset.theme = light ? 'light' : 'dark';
	root.classList.toggle('dark', !light);
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? colors.light : colors.dark);
}

// Every picker on the page (the sidebar and the mobile drawer can both be
// mounted) reads the same choice and hears when it changes.
let current: Theme | undefined;
const listeners = new Set<() => void>();
function setCurrent(theme: Theme) {
	current = theme;
	listeners.forEach((listener) => listener());
}

export function saveTheme(theme: Theme) {
	try {
		if (theme === 'system') localStorage.removeItem(key);
		else localStorage.setItem(key, theme);
	} catch {
		// The choice then lasts until the page closes.
	}
	applyTheme(theme);
	setCurrent(theme);
}

// startTheme keeps the page in step with the system colour scheme and with a
// choice made in another tab (the app or the account page).
export function startTheme() {
	applyTheme(storedTheme());
	if (typeof matchMedia === 'function') matchMedia(query).addEventListener('change', () => applyTheme(current ?? storedTheme()));
	window.addEventListener('storage', (e) => {
		if (e.key !== key && e.key !== null) return;
		applyTheme(storedTheme());
		setCurrent(storedTheme());
	});
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
const snapshot = () => (current ??= storedTheme());

export function useTheme(): [Theme, (theme: Theme) => void] {
	return [useSyncExternalStore(subscribe, snapshot), saveTheme];
}
