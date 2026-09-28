interface TelegramWebApp {
	initData: string;
	ready(): void;
	expand(): void;
	isVersionAtLeast(version: string): boolean;
	setHeaderColor(color: string): void;
	setBackgroundColor(color: string): void;
	setBottomBarColor(color: string): void;
	onEvent(event: 'themeChanged', callback: () => void): void;
	offEvent(event: 'themeChanged', callback: () => void): void;
	BackButton: {
		show(): void;
		hide(): void;
		onClick(cb: () => void): void;
		offClick(cb: () => void): void;
	};
}

declare global {
	interface Window {
		Telegram?: { WebApp?: TelegramWebApp };
	}
}

export function getWebApp(): TelegramWebApp | undefined {
	return window.Telegram?.WebApp;
}

/** The SDK owns theme/viewport CSS variables; only native chrome needs setup here. */
export function setupWebApp(): (() => void) | undefined {
	const webApp = getWebApp();
	if (!webApp) return;
	const syncColors = () => {
		if (webApp.isVersionAtLeast('6.1')) {
			webApp.setHeaderColor('bg_color');
			webApp.setBackgroundColor('bg_color');
		}
		if (webApp.isVersionAtLeast('7.10')) webApp.setBottomBarColor('bottom_bar_bg_color');
	};
	syncColors();
	webApp.onEvent('themeChanged', syncColors);
	webApp.ready();
	webApp.expand();
	return () => webApp.offEvent('themeChanged', syncColors);
}

export function initDataString(): string {
	return getWebApp()?.initData ?? '';
}

/** Deep links seed navigation once at startup. */
export function readDeepLinkParams(): { screen: string | null; id: string | null } {
	const params = new URLSearchParams(window.location.search);
	return { screen: params.get('screen'), id: params.get('id') };
}
