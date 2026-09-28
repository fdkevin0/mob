import { describe, expect, it } from 'vitest';
import { nav, visibleTabsFor, isBackButtonVisible, currentScreen, type NavState } from './nav';

const ADMIN_CAPS = ['view_debug', 'schedule_turns', 'manage_email', 'admin_ops'] as const;
const MEMBER_CAPS = ['schedule_turns'] as const;

function initState(capabilities: readonly string[], deepLink: { screen: string | null; id: string | null } = { screen: null, id: null }): NavState {
	return nav({ activeTab: 'settings', visibleTabs: ['settings'], stack: [{ screen: 'settingsRoot' }] }, { type: 'init', capabilities: [...capabilities] as never, deepLink });
}

describe('visibleTabsFor', () => {
	it('always includes settings', () => {
		expect(visibleTabsFor([])).toEqual(['settings', 'memory', 'bookmarks']);
	});

	it('includes email only with manage_email', () => {
		expect(visibleTabsFor([...MEMBER_CAPS] as never)).toEqual(['settings', 'memory', 'bookmarks']);
		expect(visibleTabsFor([...ADMIN_CAPS] as never)).toEqual(['settings', 'memory', 'bookmarks', 'email']);
	});
});

describe('nav init (seeding)', () => {
	it('with no deep link, lands on the settings tab root', () => {
		const state = initState(ADMIN_CAPS);
		expect(state.activeTab).toBe('settings');
		expect(state.stack).toEqual([{ screen: 'settingsRoot' }]);
		expect(isBackButtonVisible(state)).toBe(false);
	});

	it('cold-launches an admin straight into email detail with the tab bar visible', () => {
		const state = initState(ADMIN_CAPS, { screen: 'email', id: '42' });
		expect(state.activeTab).toBe('email');
		expect(state.visibleTabs).toEqual(['settings', 'memory', 'bookmarks', 'email']);
		expect(state.stack).toEqual([{ screen: 'emailList' }, { screen: 'emailDetail', id: 42 }]);
		expect(isBackButtonVisible(state)).toBe(true);
	});

	it('a non-admin deep link (missing manage_email) falls back to the settings root, not a broken email screen', () => {
		const state = initState(MEMBER_CAPS, { screen: 'email', id: '42' });
		expect(state.activeTab).toBe('settings');
		expect(state.visibleTabs).toEqual(['settings', 'memory', 'bookmarks']);
		expect(state.stack).toEqual([{ screen: 'settingsRoot' }]);
	});

	it('a malformed deep-link id is ignored, not coerced into NaN', () => {
		const state = initState(ADMIN_CAPS, { screen: 'email', id: 'not-a-number' });
		expect(state.activeTab).toBe('settings');
		expect(state.stack).toEqual([{ screen: 'settingsRoot' }]);
	});

	it('a deep link for an unrelated screen value is ignored', () => {
		const state = initState(ADMIN_CAPS, { screen: 'other', id: '42' });
		expect(state.activeTab).toBe('settings');
	});
});

describe('nav push/pop', () => {
	it('push adds a screen; BackButton becomes visible', () => {
		const state = initState(ADMIN_CAPS);
		const pushed = nav(state, { type: 'push', screen: { screen: 'chatSettings' } });
		expect(currentScreen(pushed)).toEqual({ screen: 'chatSettings' });
		expect(isBackButtonVisible(pushed)).toBe(true);
	});

	it('pop removes the top screen', () => {
		const state = initState(ADMIN_CAPS);
		const pushed = nav(state, { type: 'push', screen: { screen: 'chatSettings' } });
		const popped = nav(pushed, { type: 'pop' });
		expect(currentScreen(popped)).toEqual({ screen: 'settingsRoot' });
		expect(isBackButtonVisible(popped)).toBe(false);
	});

	it('pop at a tab root is a no-op (BackButton is hidden there; closing is Telegram’s own gesture)', () => {
		const state = initState(ADMIN_CAPS);
		const popped = nav(state, { type: 'pop' });
		expect(popped).toEqual(state);
	});

	it('pop-from-cold-launch returns to the email list, tab bar still visible', () => {
		const state = initState(ADMIN_CAPS, { screen: 'email', id: '42' });
		const popped = nav(state, { type: 'pop' });
		expect(currentScreen(popped)).toEqual({ screen: 'emailList' });
		expect(popped.activeTab).toBe('email');
		expect(isBackButtonVisible(popped)).toBe(false);
	});
});

describe('nav switchTab', () => {
	it('switching tabs resets the stack to the new tab’s root', () => {
		const state = initState(ADMIN_CAPS, { screen: 'email', id: '42' });
		const switched = nav(state, { type: 'switchTab', tab: 'settings' });
		expect(switched.activeTab).toBe('settings');
		expect(switched.stack).toEqual([{ screen: 'settingsRoot' }]);
	});

	it('switching to a tab the principal lacks the capability for is a no-op', () => {
		const state = initState(MEMBER_CAPS);
		const switched = nav(state, { type: 'switchTab', tab: 'email' });
		expect(switched).toEqual(state);
	});
});

it('opens a bookmark deep link and returns to its list', () => {
	const id = '12345678-1234-1234-1234-123456789012';
	const state = initState(MEMBER_CAPS, { screen: 'bookmark', id });
	expect(state.activeTab).toBe('bookmarks');
	expect(currentScreen(state)).toEqual({ screen: 'bookmarkDetail', id });
	expect(currentScreen(nav(state, { type: 'pop' }))).toEqual({ screen: 'bookmarks' });
});
