import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { adjacent, Gestures, magnet, spring } from './snap';

const pages = [0, 800, 1280, 2400];

it('turns to the next page either way', () => {
  expect(adjacent(pages, 0, 1)).toBe(800);
  expect(adjacent(pages, 800, 1)).toBe(1280);
  expect(adjacent(pages, 900, -1)).toBe(800);
  expect(adjacent(pages, 800.5, -1)).toBe(0);
  expect(adjacent(pages, 2400, 1)).toBeUndefined();
  expect(adjacent(pages, 0, -1)).toBeUndefined();
});

it('springs onto the page without overshooting', () => {
  const omega = 9, x0 = -800, v0 = omega * 800 * 0.6;
  let last = x0;
  for (let t = 0.01; t < 1; t += 0.01) {
    const [x] = spring(x0, v0, omega, t);
    expect(x).toBeLessThanOrEqual(0);
    expect(x).toBeGreaterThanOrEqual(last);
    last = x;
  }
  expect(Math.abs(spring(x0, v0, omega, 0.8)[0])).toBeLessThan(5);
  expect(spring(x0, v0, omega, 0)[1]).toBeCloseTo(v0);
});

it('turns one page for a burst of wheel notches', () => {
  const g = new Gestures();
  expect([0, 60, 120, 180].map(t => g.feed(100, t))).toEqual([true, false, false, false]);
  expect(g.feed(100, 500)).toBe(true);
  expect(g.feed(-100, 520)).toBe(true);
});

it('turns one page for a trackpad swipe and its momentum, and again for a new swipe', () => {
  const g = new Gestures();
  const swipe = [2, 6, 14, 30, 42, 40, 34, 28, 22, 17, 13, 10, 8, 6, 5, 4, 3, 2, 2, 1];
  const turns = swipe.map((dy, i) => g.feed(dy, i * 16)).filter(Boolean).length;
  expect(turns).toBe(1);
  // A fresh swipe while the momentum is still dying away.
  expect([1, 20, 36].map((dy, i) => g.feed(dy, (swipe.length + i) * 16))).toContain(true);
});

// A window whose scroll and frames the test drives.
let y = 0;
let frames: (FrameRequestCallback | undefined)[] = [];
const flush = (now: number) => { const run = frames; frames = []; run.forEach(f => f?.(now)); };
const wheel = (deltaY: number, timeStamp: number) => {
  const e = new WheelEvent('wheel', { deltaY, cancelable: true });
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
beforeEach(() => {
  y = 0;
  frames = [];
  Object.defineProperty(window, 'scrollY', { get: () => y, configurable: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(((o: ScrollToOptions) => { y = o.top!; }) as typeof window.scrollTo);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = undefined; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('leaves a whole wheel gesture alone below the story', () => {
  const m = magnet(() => [0, 800, 3320]);
  y = 3600;
  expect([0, 50, 100, 150].map(t => wheel(-50, t))).toEqual([false, false, false, false]);
  m.destroy();
});

it('swallows the rest of the gesture that turned onto the end of the story, then lets go', () => {
  const m = magnet(() => [0, 800, 1600]);
  y = 800;
  expect(wheel(100, 0)).toBe(true);
  for (let t = 0; t <= 2000; t += 16) flush(performance.now() + t);
  expect(y).toBe(1600);
  expect([16, 32, 48].map(t => wheel(20, t))).toEqual([true, true, true]);
  expect(wheel(100, 400)).toBe(false);
  m.destroy();
});

it('hands the scroll to a scrolling key mid-spring', () => {
  const m = magnet(() => [0, 800, 1600]);
  expect(wheel(100, 0)).toBe(true);
  expect(document.documentElement.style.scrollSnapType).toBe('none');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
  expect(document.documentElement.style.scrollSnapType).toBe('');
  const calls = vi.mocked(window.scrollTo).mock.calls.length;
  flush(performance.now() + 100);
  expect(vi.mocked(window.scrollTo).mock.calls.length).toBe(calls);
  m.destroy();
});
