import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme } from '../theme/theme';
import { Turnstile } from './Turnstile';

afterEach(() => {
	delete window.turnstile;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Turnstile', () => {
	it('draws the widget in the page scheme, not the system one, and again when it changes', async () => {
		vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		const widget = { render: vi.fn((_: HTMLElement, options: Record<string, unknown>) => `w-${options.theme}`), reset: vi.fn(), remove: vi.fn() };
		window.turnstile = widget;
		applyTheme('light');
		// The script tag "loads" as soon as it is added, without fetching.
		vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(tag: T) => { queueMicrotask(() => (tag as unknown as HTMLScriptElement).onload?.(new Event('load'))); return tag; });
		const onToken = vi.fn();
		render(<Turnstile siteKey="key" action="github" onToken={onToken} onError={() => {}} />);
		await waitFor(() => expect(widget.render).toHaveBeenLastCalledWith(expect.any(HTMLElement), expect.objectContaining({ theme: 'light' })));

		await act(async () => { applyTheme('dark'); });
		expect(widget.remove).toHaveBeenCalledWith('w-light');
		expect(onToken).toHaveBeenLastCalledWith('');
		expect(widget.render).toHaveBeenLastCalledWith(expect.any(HTMLElement), expect.objectContaining({ theme: 'dark' }));
	});
});
