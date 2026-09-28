import { afterEach, expect, it, vi } from 'vitest';
import { setupWebApp } from './telegram';

afterEach(() => { delete window.Telegram; });

it('does nothing outside Telegram', () => {
	expect(setupWebApp()).toBeUndefined();
});

it.each([
	['6.0', []],
	['6.1', ['6.1']],
	['7.9', ['6.1']],
	['7.10', ['6.1', '7.10']],
])('configures only native APIs supported by client %s', (_version, supported) => {
	const webApp = {
		initData: '', ready: vi.fn(), expand: vi.fn(),
		isVersionAtLeast: vi.fn((version: string) => supported.includes(version)),
		setHeaderColor: vi.fn(), setBackgroundColor: vi.fn(), setBottomBarColor: vi.fn(),
		onEvent: vi.fn(), offEvent: vi.fn(),
		BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
	};
	window.Telegram = { WebApp: webApp };
	const dispose = setupWebApp();
	expect(webApp.ready).toHaveBeenCalledOnce();
	expect(webApp.expand).toHaveBeenCalledOnce();
	expect(webApp.setHeaderColor.mock.calls).toEqual(supported.includes('6.1') ? [['bg_color']] : []);
	expect(webApp.setBackgroundColor.mock.calls).toEqual(supported.includes('6.1') ? [['bg_color']] : []);
	expect(webApp.setBottomBarColor.mock.calls).toEqual(supported.includes('7.10') ? [['bottom_bar_bg_color']] : []);
	const [event, syncColors] = webApp.onEvent.mock.calls[0] as unknown as [string, () => void];
	expect(event).toBe('themeChanged');
	syncColors();
	expect(webApp.setHeaderColor).toHaveBeenCalledTimes(supported.includes('6.1') ? 2 : 0);
	dispose?.();
	expect(webApp.offEvent).toHaveBeenCalledWith('themeChanged', syncColors);
});
