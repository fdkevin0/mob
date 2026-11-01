import { expect, it } from 'vitest';
import type { Voxel } from './model';
import { lit, shade } from './project';

const paper: [number, number, number] = [0xf4 / 255, 0xf3 / 255, 0xee / 255];
const sides = [shade.top, shade.left, shade.right];

it('fades after lighting, so a fully faded voxel is the backdrop on every face', () => {
	const calf: Voxel = [0, 0, 0, 0.9, 0.5, 0.2, 0, 1, 0];
	for (const k of sides) expect(lit(calf, k, paper)).toEqual([0xf4, 0xf3, 0xee]);
	const glowing: Voxel = [0, 0, 0, 0.8, 0.9, 0.3, 1, 1, 0];
	for (const k of sides) expect(lit(glowing, k, paper)).toEqual([0xf4, 0xf3, 0xee]);
});

it('leaves an unfaded voxel as lit, whatever the backdrop', () => {
	const calf: Voxel = [0, 0, 0, 0.5, 0.5, 0.5, 0, 1];
	expect(lit(calf, shade.right, paper)).toEqual(lit(calf, shade.right));
	expect(lit(calf, shade.right)).toEqual([77, 77, 77]);
});
