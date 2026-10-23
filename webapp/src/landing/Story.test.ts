import { expect, it } from 'vitest';
import { featureFor, features } from './Story';
import { calfAt, census, officeVoxels, setStory, type Activity } from './voxel/office';

it('links every calf activity to a feature, except napping and high-fives', () => {
  const activities: Activity[] = ['work', 'back', 'deliver', 'ask', 'lead', 'sandbox', 'memo', 'drink', 'nap', 'high-five'];
  expect(activities.filter(a => featureFor(a) === undefined)).toEqual(['nap', 'high-five']);
  expect(new Set(activities.map(featureFor).filter(i => i !== undefined))).toEqual(new Set(features.keys()));
});

it('has calves doing every kind of thing, and finds them under the pointer', () => {
  const seen = new Set<Activity>();
  for (let t = 0; t < 400; t += 0.5) {
    officeVoxels(t);
    if (t % 5) continue;
    for (let x = 0; x < 720; x += 6) for (let y = 0; y < 450; y += 6) {
      const a = calfAt(x, y, 720, 450);
      if (a) seen.add(a);
    }
  }
  for (const a of ['work', 'deliver', 'ask', 'lead', 'sandbox', 'memo', 'drink', 'nap', 'high-five'] as Activity[]) expect(seen).toContain(a);
  expect(calfAt(0, 0, 720, 450)).toBeUndefined();
});

it('plays each step of the task without losing the office', () => {
  const before = officeVoxels(401).length;
  for (const step of [0, 1, 2, 3]) {
    setStory(step);
    expect(officeVoxels(402 + step * 4).length).toBeGreaterThan(before * 0.9);
  }
  setStory(undefined);
});

it('draws the agent tree on the floor once the work is handed out', () => {
  const lines = (step: number, t: number) => { setStory(step); return officeVoxels(t).filter(v => v[1] === -0.3).length; };
  expect(lines(0, 420)).toBe(0);
  // Three lines: the leader to both desks, and one desk to its helper.
  for (const step of [2, 3]) expect(lines(step, 430 + step)).toBeGreaterThan(30);
  setStory(undefined);
});

it('keeps most calves at their desks, with only a few up at a time', () => {
  let desk = 0, all = 0;
  for (let t = 500; t < 800; t += 1) {
    officeVoxels(t);
    for (const [a, n] of Object.entries(census())) { all += n!; if (a === 'work' || a === 'ask') desk += n!; }
  }
  // Each load is a new random office, about 0.79 on average; wandering ones sit near 0.4.
  expect(desk / all).toBeGreaterThan(0.7);
});
