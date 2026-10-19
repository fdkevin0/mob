import { alarm, calf, calves, colors, desk, lying, move, snore, turn, type CalfStyle, type Pose, type RGB, type Voxel } from './model';

// The hero's loop, about 14 seconds. The boss calf catches a request from
// the sky, throws tasks to four workers, whips the one who is slacking,
// gathers the results, files one in memory and sends the answer back up.
// Everything is a function of the time in the loop.

export const LOOP = 14;
const FLOOR = 26;

export type Facing = 0 | 1 | 2 | 3; // +z, +x, -z, -x
export type Vec = [number, number, number];

export const rotate = ([x, y, z]: Vec, f: Facing): Vec => f === 0 ? [x, y, z] : f === 1 ? [z, y, -x] : f === 2 ? [-x, y, -z] : [-z, y, x];
export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

type Worker = { style: CalfStyle; at: Vec; facing: Facing; boss: Facing; task: number; result: number };

// Five calves stand in a row across the screen, the boss in the middle. The
// two on the left face +x and the two on the right face +z, so every face
// turns toward the camera and the middle. Each worker's desk is in front of
// it. Times are when its task leaves the boss and its result comes back.
const workers: Worker[] = [
	{ style: calves.brown, at: [16, 0, -16], facing: 0, boss: 1, task: 1.4, result: 7.0 },
	{ style: calves.lime, at: [-8, 0, 8], facing: 1, boss: 0, task: 1.9, result: 7.3 },
	{ style: calves.blue, at: [-16, 0, 16], facing: 1, boss: 0, task: 2.4, result: 7.6 },
	{ style: calves.lilac, at: [8, 0, -8], facing: 0, boss: 1, task: 4.1, result: 8.3 },
];
const LAZY = 3;
const FLIGHT = 0.7;
const memoryAt: Vec = [-7, 0, 1];
const deskOf = (w: Worker) => add(w.at, rotate([0, 0, 4], w.facing));

// Block positions relative to a calf facing +z.
const overhead: Vec = [0, 11.6, 0.5];
const inHooves: Vec = [0, 6.4, 3.6];
const onDesk: Vec = [0, 5.4, 0.5];

const within = (t: number, a: number, b: number) => t >= a && t < b;
const frameOf = (t: number, rate: number) => Math.floor(t * rate);

// A thrown block follows a parabola, snapped to half cells so it hops.
export function arc(from: Vec, to: Vec, p: number, height = 5): Vec {
	const q = Math.min(1, Math.max(0, p));
	const lift = 4 * height * q * (1 - q);
	const snap = (v: number) => Math.round(v * 2) / 2;
	return [snap(from[0] + (to[0] - from[0]) * q), snap(from[1] + (to[1] - from[1]) * q + lift), snap(from[2] + (to[2] - from[2]) * q)];
}

export const block = (at: Vec, color: RGB, size = 1.6, glow = 0.6): Voxel => [at[0] - 0.5, at[1] - 0.5, at[2] - 0.5, ...color, glow, size];

function place(style: CalfStyle, pose: Pose, facing: Facing, at: Vec, t: number, hop = 0): Voxel[] {
	return move(turn(calf(style, pose, frameOf(t, 6)), facing), at[0], at[1] + hop, at[2]);
}

// A stage that runs across the screen: |x + z| is its depth, x - z its width.
function floor(): Voxel[] {
	const voxels: Voxel[] = [];
	for (let x = -FLOOR; x < FLOOR; x++) for (let z = -FLOOR; z < FLOOR; z++) {
		if (Math.abs(x + z + 0.5) > 7 || Math.abs(x - z) > 38) continue;
		const checker = (Math.floor(x / 2) + Math.floor(z / 2)) % 2 === 0;
		voxels.push([x, -1, z, ...(checker ? colors.floorA : colors.floorB), 0, 1]);
	}
	return voxels;
}

const ground = floor();
const desks = workers.flatMap(w => move(turn(desk(), w.facing), ...deskOf(w)));

function bossPose(t: number): { pose: Pose; facing: Facing } {
	const caught = workers.map(w => w.result + FLIGHT);
	if (within(t, 0.6, 1.15)) return { pose: 'catch', facing: 0 };
	for (let i = 0; i < 3; i++) if (within(t, workers[i].task - 0.15, workers[i].task + 0.1)) return { pose: 'throw', facing: workers[i].boss };
	if (within(t, 2.6, 4.25)) {
		if (within(t, 2.8, 3.05) || within(t, 3.25, 3.45)) return { pose: 'whip-up', facing: 1 };
		if (within(t, 3.05, 3.25) || within(t, 3.45, 3.65)) return { pose: 'whip-crack', facing: 1 };
		if (within(t, 3.95, 4.25)) return { pose: 'throw', facing: 1 };
		return { pose: 'idle', facing: 1 };
	}
	for (let i = 0; i < 4; i++) if (within(t, caught[i] - 0.2, caught[i] + 0.15)) return { pose: 'catch', facing: workers[i].boss };
	if (within(t, 9.15, 9.4)) return { pose: 'throw', facing: 0 };
	if (within(t, 9.7, 10.0)) return { pose: 'catch', facing: 0 };
	if (within(t, caught[0], 9.7)) return { pose: 'hold', facing: 0 };
	return { pose: 'idle', facing: 0 };
}

function workerPose(w: Worker, i: number, t: number): { voxels: Voxel[]; extra: Voxel[] } {
	const arrive = w.task + FLIGHT;
	const extra: Voxel[] = [];
	let pose: Pose = 'idle', hop = 0;
	if (i === LAZY && (t < 3.05 || t >= 10.8)) {
		// Slacking: flat on its back behind its desk, snoring.
		const z = (t * 0.8) % 1.6;
		extra.push(...snore(w.at[0] - 3, w.at[1] + 5 + z * 2, w.at[2] - 2, 0.45));
		return { voxels: move(turn(lying(calf(w.style, 'lie')), 1), w.at[0] + 6, w.at[1], w.at[2] - 2), extra };
	}
	if (i === LAZY && within(t, 3.05, 3.7)) {
		pose = 'startle'; hop = within(t, 3.1, 3.35) ? 1 : 0;
		extra.push(...alarm(w.at[0], w.at[1] + 17, w.at[2]));
	} else if (within(t, arrive - 0.15, arrive + 0.25)) pose = 'catch';
	else if (within(t, arrive + 0.25, w.result - 0.3)) pose = within(t, arrive + 0.25, arrive + 0.5) ? 'hold' : 'type';
	else if (within(t, w.result - 0.15, w.result + 0.1)) pose = 'throw';
	else if (i === 0 && within(t, 11.2, 11.9)) pose = 'stretch';
	return { voxels: place(w.style, pose, w.facing, w.at, t, hop), extra };
}

// Blocks in flight, in hooves, on desks and in the memory stack.
function blocks(t: number): Voxel[] {
	const out: Voxel[] = [];
	const boss: Vec = [0, 0, 0];
	// The request drops from the sky; the answer goes back up.
	if (t < 0.9) out.push(block(arc([0, 44, 0.5], add(boss, overhead), t / 0.9, 0), colors.white, 1.6, 1));
	else if (t < 1.25) out.push(block(add(boss, overhead), colors.white, 1.6, 1));
	if (within(t, 9.85, 11)) out.push(block(arc(add(boss, overhead), [0, 48, 0.5], (t - 9.85) / 1.1, 0), colors.white, 1.8, 1));

	workers.forEach((w, i) => {
		const from = add(boss, rotate(inHooves, w.boss));
		const hands = add(w.at, rotate(overhead, w.facing));
		const arrive = w.task + FLIGHT;
		const deskTop = add(deskOf(w), rotate(onDesk, w.facing));
		if (within(t, w.task, arrive)) out.push(block(arc(from, hands, (t - w.task) / FLIGHT), colors.lime));
		else if (within(t, arrive, arrive + 0.4)) out.push(block(hands, colors.lime));
		else if (within(t, arrive + 0.4, w.result - 0.3)) {
			// Processing: the block flickers and sheds bits.
			const k = frameOf(t, 4) % 3;
			out.push(block(deskTop, [colors.cyan, colors.lime, colors.amber][k], 1.6, 0.8));
			for (let b = 0; b < 3; b++) {
				const s = Math.sin((frameOf(t, 5) + b * 7 + i * 3) * 12.9898) * 43758.5453;
				const r = s - Math.floor(s);
				out.push(block(add(deskTop, [Math.round((r - 0.5) * 6) / 2, 1.5 + Math.round(r * 4) / 2, Math.round((0.5 - r) * 4) / 2]), colors.cyan, 0.5, 1));
			}
		} else if (within(t, w.result - 0.3, w.result)) out.push(block(hands, colors.cyan));
		const back = w.result + FLIGHT;
		if (within(t, w.result, back)) out.push(block(arc(hands, add(boss, overhead), (t - w.result) / FLIGHT), colors.cyan));
	});

	// Results pile up in the boss's hooves until it files and sends them.
	const held = workers.filter(w => t >= w.result + FLIGHT && t < 9.2).length;
	for (let k = 0; k < held; k++) out.push(block(add(boss, [0, inHooves[1] + k * 1.3, inHooves[2]]), colors.cyan, 1.2, 0.6));

	// Memory: a stack that gains a layer when the boss files a result.
	const filed = t >= 9.9 ? 1 : 0;
	for (let layer = 0; layer < 3 + filed; layer++) {
		for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) out.push([memoryAt[0] + x, layer, memoryAt[2] + z, ...colors.violet, layer === 2 + filed && filed ? 0.8 : 0.15, 1]);
	}
	if (within(t, 9.25, 9.9)) out.push(block(arc(add(boss, rotate(inHooves, 0)), [memoryAt[0] + 1, 4.5, memoryAt[2] + 1], (t - 9.25) / 0.65, 3), colors.violet));
	return out;
}

export function heroVoxels(time: number): Voxel[] {
	const t = ((time % LOOP) + LOOP) % LOOP;
	const { pose, facing } = bossPose(t);
	const voxels: Voxel[] = [...ground, ...desks, ...place(calves.boss, pose, facing, [0, 0, 0], t)];
	workers.forEach((w, i) => { const { voxels: v, extra } = workerPose(w, i, t); voxels.push(...v, ...extra); });
	voxels.push(...blocks(t));
	return voxels;
}

// Fits the platform to a canvas of this size (in its own pixels).
// Wide screens show the whole row; narrow ones crop the outer calves.
export function heroFrame(width: number, height: number) {
	const unit = Math.min(width / (width > height ? 58 : 36), height / 22);
	return { unit, x: width / 2, y: Math.min(height * (width > height ? 0.8 : 0.66), height - 5 * unit) };
}
