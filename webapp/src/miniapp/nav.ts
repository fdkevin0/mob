import type { Capability } from '../../../src/features/miniapp/contract';

export type TabId = 'settings' | 'memory' | 'email' | 'bookmarks';

export type Screen =
	| { screen: 'bookmarks' }
	| { screen: 'bookmarkDetail'; id: string }
	| { screen: 'settingsRoot' }
	| { screen: 'chatSettings' }
	| { screen: 'globalService' }
	| { screen: 'memoryRoot' }
	| { screen: 'emailList' }
	| { screen: 'emailDetail'; id: number };

export interface NavState {
	activeTab: TabId;
	/** Presentation only; the server enforces capabilities. */
	visibleTabs: TabId[];
	/** Non-empty stack for the active tab, with its root first. */
	stack: Screen[];
}

export interface DeepLinkParams {
	screen: string | null;
	id: string | null;
}

export type NavAction =
	| { type: 'init'; capabilities: Capability[]; deepLink: DeepLinkParams }
	| { type: 'push'; screen: Screen }
	| { type: 'pop' }
	| { type: 'switchTab'; tab: TabId };

function rootScreenFor(tab: TabId): Screen {
	if (tab === 'bookmarks') return { screen: 'bookmarks' };
	if (tab === 'settings') return { screen: 'settingsRoot' };
	if (tab === 'memory') return { screen: 'memoryRoot' };
	return { screen: 'emailList' };
}

/** Settings and Memory rely on the base use_commands check at every Mini App endpoint. */
export function visibleTabsFor(capabilities: Capability[]): TabId[] {
	const tabs: TabId[] = ['settings', 'memory', 'bookmarks'];
	if (capabilities.includes('manage_email')) tabs.push('email');
	return tabs;
}

function deepLinkEmailId(id: string | null): number | null {
	if (id === null) return null;
	const parsed = Number(id);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Navigation stays in React state so Telegram BackButton owns back navigation. */
export function nav(state: NavState, action: NavAction): NavState {
	switch (action.type) {
		case 'init': {
			const tabs = visibleTabsFor(action.capabilities);
			if (action.deepLink.screen === 'bookmark' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(action.deepLink.id ?? '')) {
				return { activeTab: 'bookmarks', visibleTabs: tabs, stack: [{ screen: 'bookmarks' }, { screen: 'bookmarkDetail', id: action.deepLink.id! }] };
			}
			const emailId = action.deepLink.screen === 'email' ? deepLinkEmailId(action.deepLink.id) : null;
			if (emailId !== null && tabs.includes('email')) {
				return { activeTab: 'email', visibleTabs: tabs, stack: [{ screen: 'emailList' }, { screen: 'emailDetail', id: emailId }] };
			}
			const activeTab = tabs[0] ?? 'settings';
			return { activeTab, visibleTabs: tabs, stack: [rootScreenFor(activeTab)] };
		}
		case 'push':
			return { ...state, stack: [...state.stack, action.screen] };
		case 'pop':
			return state.stack.length > 1 ? { ...state, stack: state.stack.slice(0, -1) } : state;
		case 'switchTab':
			if (!state.visibleTabs.includes(action.tab)) return state;
			return { ...state, activeTab: action.tab, stack: [rootScreenFor(action.tab)] };
		default:
			return state;
	}
}

export function isBackButtonVisible(state: NavState): boolean {
	return state.stack.length > 1;
}

export function currentScreen(state: NavState): Screen {
	const top = state.stack.at(-1);
	if (!top) throw new Error('nav stack is unexpectedly empty');
	return top;
}
