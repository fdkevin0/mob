import { afterEach, expect, it, vi } from 'vitest';
import { keepOffer, openApp, pendingOffer } from './auth';

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

it('keeps a #offer= link out of the address bar until the app opens', () => {
  window.history.replaceState(null, '', '/?signin=app#offer=abc');
  expect(keepOffer()).toBe(true);
  expect(window.location.hash).toBe('');
  expect(window.location.search).toBe('?signin=app');
  expect(pendingOffer()).toBe(true);
});

it('ignores a fragment without an offer', () => {
  window.history.replaceState(null, '', '/#features');
  expect(keepOffer()).toBe(false);
  expect(pendingOffer()).toBe(false);
});

it('uses a waiting link once when the app opens', () => {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  sessionStorage.setItem('mob.pendingOffer', '#offer=abc');
  openApp();
  expect(assign).toHaveBeenLastCalledWith('/app#offer=abc');
  expect(pendingOffer()).toBe(false);
  openApp();
  expect(assign).toHaveBeenLastCalledWith('/app');
});
