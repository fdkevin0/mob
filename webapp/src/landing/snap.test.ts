import { expect, it } from 'vitest';
import { snapTarget } from './snap';

const pages = [0, 1000, 1600, 3000];

it('leans the way the user was scrolling', () => {
  expect(snapTarget(pages, 100, 1)).toBe(1000);
  expect(snapTarget(pages, 30, 1)).toBe(0);
  expect(snapTarget(pages, 900, -1)).toBe(0);
  expect(snapTarget(pages, 970, -1)).toBe(1000);
  expect(snapTarget(pages, 1400, 0)).toBe(1600);
  expect(snapTarget(pages, 1640, 1)).toBe(1600);
  expect(snapTarget(pages, 1650, 1)).toBe(3000);
});

it('needs a bigger share of a short gap', () => {
  expect(snapTarget([0, 200], 25, 1)).toBe(0);
  expect(snapTarget([0, 200], 35, 1)).toBe(200);
});

it('leaves the scroll alone on a page or outside the pages', () => {
  expect(snapTarget(pages, 1001, 1)).toBeUndefined();
  expect(snapTarget(pages, 3000, 1)).toBeUndefined();
  expect(snapTarget(pages, 3500, -1)).toBeUndefined();
  expect(snapTarget([], 10, 1)).toBeUndefined();
});
