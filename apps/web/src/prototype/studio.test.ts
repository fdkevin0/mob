import { expect, it } from 'vitest';
import type { Voxel } from '../landing/voxel/model';
import { rowZ, stations, studio, where } from './studio';

const lime = (v: Voxel) => v[3] === 0xc8 / 255 && v[4] === 0xf5 / 255;

it('walks each agent from its desk to the checks and back as its task moves', () => {
	expect(where(0, 0).phase?.stage).toBe('build');
	expect(where(0, 5).phase?.stage).toBe('verify');
	// The checkout field fails its checks once and goes back to its desk to fix them.
	expect(where(1, 9.5).phase).toMatchObject({ stage: 'build', tries: 1 });
	expect(where(2, 30).phase?.stage).toBe('ready');
});

it('draws the plan waiting for you, then each task landing in your tray', () => {
	const waiting = studio(undefined, 0, 0);
	const later = studio({ approved: true, at: 0 }, 30_000, 0);
	// Ready work sits in the tray, lit lime, on every row.
	const inTray = (v: Voxel[]) => [0, 1, 2].filter((i) => v.some((p) => lime(p) && p[0] === stations.tray - 0.5 && p[2] === rowZ(i) - 0.5)).length;
	expect(inTray(waiting)).toBe(0);
	expect(inTray(later)).toBe(3);
});
