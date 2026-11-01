import { expect, it } from 'vitest';
import type { Voxel } from '@mob/ui/voxel/model';
import { rowZ, stations, studioVoxels, type StudioRow } from './studioScene';

const row = (r: Partial<StudioRow>): StudioRow => ({ checks: true, review: true, since: Infinity, ...r });
const near = (v: Voxel[], x: number, z: number, d = 3) => v.filter((p) => Math.abs(p[0] - x) <= d && Math.abs(p[2] - z) <= d && p[1] >= 0);
const lime = (p: Voxel) => p[3] === 0xc8 / 255 && p[4] === 0xf5 / 255 && p[6] === 1;

it('puts each task where it is: at its desk, in the booth, with the reviewer, or in your tray', () => {
	const rows = [row({ place: 'build' }), row({ place: 'verify' }), row({ place: 'ready', review: false })];
	const v = studioVoxels({ rows, waiting: false }, 0);
	// Each agent stands at its station: many voxels of a calf there.
	expect(near(v, stations.desk, rowZ(0)).length).toBeGreaterThan(100);
	expect(near(v, stations.checks, rowZ(1)).length).toBeGreaterThan(100);
	// Only ready work sits lit in the tray.
	expect(near(v, stations.tray, rowZ(2), 1).some(lime)).toBe(true);
	expect(near(v, stations.tray, rowZ(0), 1).some(lime)).toBe(false);
});

it('walks a task between stations when it moves on', () => {
	const walking = studioVoxels({ rows: [row({ place: 'verify', from: 'build', since: 0.6 })], waiting: false }, 0);
	const halfway = (stations.desk + stations.checks) / 2;
	expect(near(walking, halfway, rowZ(0), 4).length).toBeGreaterThan(100);
	expect(near(walking, stations.checks, rowZ(0), 2).length).toBeLessThan(near(studioVoxels({ rows: [row({ place: 'verify' })], waiting: false }, 0), stations.checks, rowZ(0), 2).length);
});

it('leaves out the stations a task does not have', () => {
	const count = (r: Partial<StudioRow>) => studioVoxels({ rows: [row(r)], waiting: false }, 0).length;
	expect(count({ checks: false, review: false })).toBeLessThan(count({ checks: true, review: false }));
	expect(count({ checks: true, review: false })).toBeLessThan(count({ checks: true, review: true }));
});
