// The plan as a studio of calves (the landing page's voxel office, made to
// follow a plan): one row per task, from the agent's desk through the checks
// booth and the reviewer to your tray. Each calf does what its task is doing,
// worked out from the same timeline the card reads (plan.ts), so the studio
// and the card always agree.
import { calf, colors, hex, leader, move, skin, turn, type CalfStyle, type Pose, type RGB, type Voxel } from '../landing/voxel/model';
import { add, arc, block, glyph, QUESTION, rotate, TICK_MARK, type Facing, type Vec } from '../landing/voxel/motion';
import type { Frame } from '../landing/voxel/project';
import { phases, plan, stagesOf } from './plan';

// Where a decision leaves the plan: waiting for you, approved at `at` (ms) with the owner's changes, or denied.
export type Decision = { approved: boolean; at: number; input?: unknown } | undefined;

const WIDTH = 110, ROW = 20, ROWS = plan.tasks!.length, DEPTH = (ROWS - 1) * ROW + 22;
const WALK = 1.2; // seconds to walk between stations
const BOSS: Vec = [7, 0, 9 + ((ROWS - 1) * ROW) / 2];

// Stations along each row, left to right.
export const stations = { desk: 26, checks: 52, review: 76, reviewer: 84, tray: 102 };
export const rowZ = (i: number) => 9 + i * ROW;

const rooms = {
	dark: { a: hex('#1b1f24'), b: hex('#181b20'), lane: hex('#21252b'), wall: hex('#23272e'), top: hex('#2c313a'), booth: hex('#16262b') },
	light: { a: hex('#d9d5c8'), b: hex('#d2cec0'), lane: hex('#e2dfd4'), wall: hex('#c9c5b7'), top: hex('#dedacd'), booth: hex('#c4d8d8') },
};
const furniture = { table: hex('#8a7a66'), edge: hex('#6c5f50'), leg: hex('#3a4048'), screen: hex('#0f1114'), tray: hex('#4a3a30'), post: hex('#3a4f57') };
const theme = () => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: RGB, glow = 0): Voxel[] {
	const v: Voxel[] = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) v.push([x, y, z, ...c, glow, 1]);
	return v;
}
const big = (x: number, y: number, z: number, s: number, c: RGB): Voxel => [x + s / 2 - 0.5, y + s / 2 - 0.5, z + s / 2 - 0.5, ...c, 0, s];

// The room and its furniture, which only change with the colour scheme and the plan's stages.
const built = new Map<string, Voxel[]>();
function room(reviewed: boolean[]): Voxel[] {
	const key = `${theme()} ${reviewed.join()}`;
	const cached = built.get(key);
	if (cached) return cached;
	const c = rooms[theme()];
	const v: Voxel[] = [];
	for (let x = 0; x < WIDTH; x += 4) for (let z = 0; z < DEPTH; z += 4) {
		const lane = Array.from({ length: ROWS }, (_, i) => rowZ(i)).some((r) => z <= r && r < z + 4);
		v.push(big(x, -4, z, 4, lane ? c.lane : ((x + z) / 4) % 2 ? c.a : c.b));
	}
	for (let i = 0; i < WIDTH; i += 2) for (let y = 0; y < 10; y += 2) v.push(big(i, y, -2, 2, y === 8 ? c.top : c.wall));
	for (let i = 0; i < DEPTH; i += 2) for (let y = 0; y < 10; y += 2) v.push(big(-2, y, i, 2, y === 8 ? c.top : c.wall));
	for (let i = 0; i < ROWS; i++) {
		const z = rowZ(i);
		// The agent's desk, in front of its seat, with a monitor facing it.
		const d = stations.desk;
		v.push(...box(d - 4, d + 4, 4, 4, z + 4, z + 6, furniture.table), ...box(d - 4, d + 4, 4, 4, z + 6, z + 6, furniture.edge));
		for (const lx of [d - 4, d + 4]) v.push(...box(lx, lx, 0, 3, z + 6, z + 6, furniture.leg));
		v.push(...box(d - 1, d + 1, 5, 7, z + 6, z + 6, furniture.screen), [d - 0.5, 6.4, z + 5.5, ...colors.lime, 0.5, 0.4]);
		// The checks booth: glass on three sides, open to the row.
		const b = stations.checks;
		for (const [x, zz] of [[b - 5, z - 5], [b + 5, z - 5], [b - 5, z + 5], [b + 5, z + 5]]) v.push(...box(x, x, 0, 10, zz, zz, furniture.post));
		for (let y = 1; y <= 10; y += y === 10 ? 1 : 3) {
			for (let x = b - 4; x < b + 5; x += y === 10 ? 1 : 2) v.push([x, y, z - 5, ...colors.cyan, 0.35, y === 10 ? 1 : 0.35], [x, y, z + 5, ...colors.cyan, 0.35, y === 10 ? 1 : 0.35]);
			for (let zz = z - 4; zz < z + 5; zz += y === 10 ? 1 : 2) v.push([b + 5, y, zz, ...colors.cyan, 0.35, y === 10 ? 1 : 0.35]);
		}
		v.push(...box(b - 4, b + 4, -1, -1, z - 4, z + 4, c.booth));
		// The reviewer's lectern, only where the task has a review.
		if (reviewed[i]) v.push(...box(stations.reviewer - 1, stations.reviewer + 1, 0, 4, z + 3, z + 5, furniture.table), ...box(stations.reviewer - 2, stations.reviewer + 2, 5, 5, z + 3, z + 5, furniture.edge));
		// Your tray at the end of the row.
		const t = stations.tray;
		v.push(...box(t - 3, t + 3, 0, 3, z - 3, z + 3, furniture.tray), ...box(t - 3, t + 3, 4, 4, z - 3, z + 3, furniture.table));
	}
	built.set(key, v);
	return v;
}

// The coats: each task's agent keeps its own, and its reviewer another.
const styles: CalfStyle[] = [skin(11), skin(29), skin(47)];
const reviewers: CalfStyle[] = [skin(61), skin(73), skin(89)];

type Calf = { at: Vec; facing: Facing; pose: Pose; frame: number; carry?: RGB; signs: Voxel[] };

// Where a task is: its phase now, the one before, and how long it has been in it.
export function where(index: number, seconds: number, changed?: unknown) {
	const run = phases(index, stagesOf(index, changed));
	let n = -1;
	for (let k = 0; k < run.length; k++) if (run[k][0] <= seconds) n = k;
	return { phase: n >= 0 ? run[n][1] : undefined, before: n > 0 ? run[n - 1][1] : undefined, since: n >= 0 ? seconds - run[n][0] : 0 };
}

const spot = (stage: string | undefined, z: number): Vec =>
	stage === 'verify' ? [stations.checks, 0, z] : stage === 'review' ? [stations.review, 0, z] : [stations.desk, 0, z];
const walkTo = (from: Vec, to: Vec, p: number): Vec => [Math.round(from[0] + (to[0] - from[0]) * Math.min(1, p)), 0, to[2]];

// The agent of task `i`, `seconds` after approval (undefined: not approved).
function agent(i: number, seconds: number | undefined, changed: unknown, t: number): Calf {
	const z = rowZ(i);
	const desk: Vec = [stations.desk, 0, z];
	if (seconds === undefined) return { at: desk, facing: 0, pose: 'idle', frame: 0, signs: [] };
	const { phase, before, since } = where(i, seconds, changed);
	if (!phase) return { at: desk, facing: 0, pose: 'idle', frame: 0, signs: [] };
	const from = spot(before?.stage, z), to = spot(phase.stage, z);
	const walking = since < WALK && (from[0] !== to[0]);
	const at = walking ? walkTo(from, to, since / WALK) : to;
	const frame = Math.floor(t * 6);
	const signs: Voxel[] = [];
	if (walking) return { at, facing: to[0] > from[0] ? 1 : 3, pose: phase.stage === 'ready' || from[0] > to[0] ? 'walk' : 'carry', frame: Math.floor(since * 8), carry: from[0] < to[0] ? colors.cyan : undefined, signs };
	switch (phase.stage) {
		case 'build':
			// Fixing what the checks found: an amber block on the desk.
			return { at, facing: 0, pose: Math.floor(t / 3 + i) % 4 ? 'type' : 'idle', frame, signs };
		case 'verify': {
			const failed = phase.passed === false && since > 1.6;
			if (failed) signs.push(...glyph(['#', '#', '#', '.', '#'], [at[0], 18, z], colors.amber));
			if (phase.passed !== false && since > 1.6) signs.push(...glyph(TICK_MARK, [at[0], 18, z], colors.lime));
			return { at, facing: 1, pose: 'hold', frame, signs };
		}
		case 'review':
			return { at, facing: 1, pose: since < 0.8 ? 'throw' : 'idle', frame, signs };
		default:
			return { at, facing: 0, pose: 'idle', frame, signs };
	}
}

function draw(c: Calf, style: CalfStyle): Voxel[] {
	const v = move(turn(calf(style, c.pose, c.frame), c.facing), c.at[0], 0, c.at[2]);
	if (c.carry) v.push(block(add(c.at, rotate([0, 6.4, 3.6], c.facing)), c.carry, 1.4, 0.8));
	return [...v, ...c.signs];
}

/** studio draws the plan `seconds` after approval, or before it, at time `t` (for idle motion). */
export function studio(decision: Decision, now: number, t: number): Voxel[] {
	const changed = decision?.approved ? decision.input : undefined;
	const seconds = decision?.approved ? (now - decision.at) / 1000 : undefined;
	const reviewed = plan.tasks!.map((_, i) => stagesOf(i, changed).some((s) => s.type === 'review'));
	const v: Voxel[] = [...room(reviewed)];
	// Mob, the gold calf, holds the plan until you decide, then hands each task to its desk.
	const boss = move(turn(calf(leader, seconds === undefined ? 'hold' : 'idle', Math.floor(t * 6)), 1), BOSS[0], 0, BOSS[2]);
	v.push(...boss);
	if (!decision) {
		v.push(block(add(BOSS, [3, 6.4, 0]), colors.amber, 2, 1), ...glyph(QUESTION, [BOSS[0], 18, BOSS[2]], colors.amber));
	}
	plan.tasks!.forEach((_, i) => {
		const z = rowZ(i);
		const deskTop: Vec = [stations.desk, 6, z + 5];
		const a = agent(i, seconds, changed, t);
		v.push(...draw(a, styles[i]));
		const w = seconds === undefined ? undefined : where(i, seconds, changed);
		// The hand-off: a block flies from Mob to the desk as the task starts.
		const stage = w?.phase?.stage;
		const handing = stage === 'build' && !w!.before && w!.since < 1;
		if (handing) v.push(block(arc(add(BOSS, [3, 7, 0]), deskTop, w!.since, 10), colors.cyan, 1.4, 1));
		// What sits on the desk: work in progress, cyan; being fixed, amber.
		if (stage === 'build' && !handing) v.push(block(deskTop, w!.phase!.tries ? colors.amber : [colors.cyan, colors.lime][Math.floor(t * 3) % 2], 1.4, 0.8));
		// In the booth the work fizzes while the checks run.
		if (stage === 'verify' && w!.since >= WALK) {
			const hands = add(a.at, rotate([0, 7.4, 3], 1));
			const failed = w!.phase!.passed === false && w!.since > 1.6;
			v.push(block(hands, failed ? colors.amber : [colors.cyan, colors.violet, colors.amber][Math.floor(t * 5) % 3], 1.6, 1));
			for (let k = 0; k < 4 && !failed; k++) {
				const p = (t * 1.3 + k / 4) % 1;
				v.push([hands[0] + Math.round(Math.sin(k * 2 + t * 3) * 3), hands[1] + p * 4, hands[2] + Math.round(Math.cos(k * 2 + t * 2) * 3), ...colors.cyan, 1, 0.4]);
			}
		}
		// The reviewer reads the work at its lectern, then ticks it.
		if (reviewed[i]) {
			const reviewing = stage === 'review' && w!.since >= WALK;
			const r = move(turn(calf(reviewers[i], reviewing ? 'hold' : 'idle', Math.floor(t * 6)), 3), stations.reviewer + 4, 0, z);
			v.push(...r);
			if (reviewing) {
				v.push(block([stations.reviewer, 6.4, z + 4], colors.cyan, 1.4, 0.8));
				if (w!.since > 3) v.push(...glyph(TICK_MARK, [stations.reviewer + 4, 18, z], colors.lime));
				else v.push(...glyph(['#.#.#'], [stations.reviewer + 4, 17, z], colors.violet));
			}
		}
		// Ready: the work lands in your tray and stays there, lit.
		if (stage === 'ready') {
			const from: Vec = reviewed[i] ? [stations.reviewer, 7, z + 4] : [stations.checks, 8, z];
			const tray: Vec = [stations.tray, 5.6, z];
			v.push(block(w!.since < 1 ? arc(from, tray, w!.since, 8) : tray, colors.lime, 1.8, 1));
			if (w!.since >= 1) v.push(...glyph(TICK_MARK, [stations.tray, 14, z], colors.lime));
		}
	});
	return v;
}

// Fits the room to the canvas, a little below the middle so the signs above the calves fit.
export function studioFrame(width: number, height: number): Frame {
	const s = Math.SQRT1_2, r = Math.sqrt(6);
	const spanX = (WIDTH + DEPTH) * s, spanY = (WIDTH + DEPTH) / r + 20;
	const unit = Math.min(width / (spanX + 4), height / (spanY + 4));
	return {
		unit,
		x: width / 2 - ((WIDTH - DEPTH) / 2) * s * unit,
		y: height / 2 - ((WIDTH + DEPTH) / r / 2 - 10) * unit,
		backdrop: theme() === 'light' ? hex('#f4f3ee') : [0, 0, 0],
	};
}
