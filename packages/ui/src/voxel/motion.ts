import type { RGB, Voxel } from './model';

// Small helpers for moving blocks and calves around a scene.

export type Facing = 0 | 1 | 2 | 3; // +z, +x, -z, -x
export type Vec = [number, number, number];

export const rotate = ([x, y, z]: Vec, f: Facing): Vec => f === 0 ? [x, y, z] : f === 1 ? [z, y, -x] : f === 2 ? [-x, y, -z] : [-z, y, x];
export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// A thrown block follows a parabola, snapped to half cells so it hops.
export function arc(from: Vec, to: Vec, p: number, height = 5): Vec {
	const q = Math.min(1, Math.max(0, p));
	const lift = 4 * height * q * (1 - q);
	const snap = (v: number) => Math.round(v * 2) / 2;
	return [snap(from[0] + (to[0] - from[0]) * q), snap(from[1] + (to[1] - from[1]) * q + lift), snap(from[2] + (to[2] - from[2]) * q)];
}

// Signs drawn above a calf: a question (it needs you) and a tick (approved, done).
export const QUESTION = ['.##.', '#..#', '..#.', '.#..', '....', '.#..'];
export const TICK_MARK = ['.....#', '....#.', '#..#..', '.##...'];

// A small sign made of half-size cubes, facing the camera, centred above (x, y, z).
export function glyph(rows: string[], [x, y, z]: Vec, color: RGB): Voxel[] {
	const v: Voxel[] = [];
	const w = rows[0].length;
	rows.forEach((row, iy) => [...row].forEach((c, ix) => {
		if (c !== '#') return;
		const d = (ix - w / 2) * 0.5;
		v.push([x + d * 0.7, y - iy * 0.55, z - d * 0.7, ...color, 1, 0.55]);
	}));
	return v;
}

export const block = (at: Vec, color: RGB, size = 1.6, glow = 0.6): Voxel => [at[0] - 0.5, at[1] - 0.5, at[2] - 0.5, ...color, glow, size];

// A small seeded random number generator (mulberry32), so scenes repeat.
export function random(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
