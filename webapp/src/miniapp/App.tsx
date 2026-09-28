import { AssetListScreen, AssetDetailScreen } from './screens/BookmarkScreen';
import { useEffect, useReducer } from 'react';
import { Button } from './ui';
import { useAsyncResource } from '../shared/useAsyncResource';
import { ResourceState } from './ResourceState';
import { api } from './api';
import { nav, isBackButtonVisible, currentScreen, type NavState, type TabId } from './nav';
import { getWebApp, readDeepLinkParams, setupWebApp } from './telegram';
import { SettingsScreen } from './screens/SettingsScreen';
import { ChatSettingsScreen } from './screens/ChatSettingsScreen';
import { GlobalServiceScreen } from './screens/GlobalServiceScreen';
import { MemoryScreen } from './screens/MemoryScreen';
import { EmailListScreen } from './screens/EmailListScreen';
import { EmailDetailScreen } from './screens/EmailDetailScreen';

const INITIAL_NAV: NavState = { activeTab: 'settings', visibleTabs: ['settings'], stack: [{ screen: 'settingsRoot' }] };

const TAB_LABELS: Record<TabId, string> = { settings: 'Settings', memory: 'Memory', email: 'Email', bookmarks: 'Bookmarks' };

export function App() {
	const [navState, dispatch] = useReducer(nav, INITIAL_NAV);
	const { data, setData, loading, error, reload } = useAsyncResource(api.bootstrap, 'Could not load settings');
	const capabilities = data?.capabilities;
	useEffect(() => {
		if (capabilities) dispatch({ type: 'init', capabilities, deepLink: readDeepLinkParams() });
	}, [capabilities]);
	const screen = currentScreen(navState);
	const backVisible = isBackButtonVisible(navState);
	const nativeBack = getWebApp()?.isVersionAtLeast('6.1') ?? false;

	useEffect(setupWebApp, []);
	useEffect(() => {
		window.scrollTo(0, 0);
	}, [screen]);

	useEffect(() => {
		const backButton = getWebApp()?.BackButton;
		if (!nativeBack || !backButton) return;
		const onClick = () => dispatch({ type: 'pop' });
		if (backVisible) {
			backButton.show();
			backButton.onClick(onClick);
		} else {
			backButton.hide();
		}
		return () => {
			backButton.offClick(onClick);
			backButton.hide();
		};
	}, [backVisible, nativeBack]);

	return (
		<div className="mx-auto flex min-h-(--tg-viewport-stable-height,100dvh) max-w-lg flex-col pt-(--safe-top) pr-(--safe-right) pl-(--safe-left)">
			<main className="min-w-0 flex-1">
				{backVisible && !nativeBack && <Button variant="plain" className="mx-1 mt-2" onClick={() => dispatch({ type: 'pop' })}>Back</Button>}
				{!data ? (
					<div className="p-4"><h1 className="mb-4 text-xl leading-tight font-semibold wrap-anywhere">Settings</h1><ResourceState loading={loading} error={error} retry={reload} /></div>
				) : (
					<>
						{screen.screen === 'settingsRoot' && (
							<SettingsScreen
								capabilities={data.capabilities}
								language={data.language}
								debug={data.debug}
								schedules={data.schedules}
								onOpenChatSettings={() => dispatch({ type: 'push', screen: { screen: 'chatSettings' } })}
								onOpenGlobalService={() => dispatch({ type: 'push', screen: { screen: 'globalService' } })}
								onLanguageChange={(stored) => setData((prev) => prev ? { ...prev, language: stored } : prev)}
								onDebugChange={(enabled) => setData((prev) => prev ? { ...prev, debug: enabled } : prev)}
								onSchedulesChange={(schedules) => setData((prev) => prev ? { ...prev, schedules } : prev)}
							/>
						)}
						{screen.screen === 'chatSettings' && <ChatSettingsScreen />}
						{screen.screen === 'globalService' && <GlobalServiceScreen />}
						{screen.screen === 'bookmarks' && <AssetListScreen onSelect={(id) => dispatch({ type: 'push', screen: { screen: 'bookmarkDetail', id } })} />}
						{screen.screen === 'bookmarkDetail' && <AssetDetailScreen key={screen.id} id={screen.id} onDeleted={() => dispatch({ type: 'pop' })} />}
						{screen.screen === 'memoryRoot' && <MemoryScreen />}
						{screen.screen === 'emailList' && <EmailListScreen onSelect={(id) => dispatch({ type: 'push', screen: { screen: 'emailDetail', id } })} />}
						{screen.screen === 'emailDetail' && <EmailDetailScreen key={screen.id} id={screen.id} />}
					</>
				)}
			</main>

			<div className="sticky bottom-0 z-10 shrink-0">
				<div id="miniapp-notifications" className="pointer-events-none absolute inset-x-0 bottom-full px-4 pb-4" />
				{data && (
					<nav className="flex border-t border-separator bg-bottom-bar pb-(--safe-bottom)" aria-label="Main navigation">
						{navState.visibleTabs.map((tab) => <button key={tab} type="button"
							className="min-h-12 flex-1 text-sm text-muted aria-[current=page]:font-semibold aria-[current=page]:text-primary"
							aria-current={tab === navState.activeTab ? 'page' : undefined}
							onClick={() => dispatch({ type: 'switchTab', tab })}>{TAB_LABELS[tab]}</button>)}
					</nav>
				)}
			</div>
		</div>
	);
}
