// A plan as a studio of calves, in the landing page's voxel style: one row per
// task, from the agent's desk through the checks booth and the reviewer's
// lectern to your tray. Each calf does what its task is doing; PlanStudio says
// where each task is and since when, and this draws it.
import { calf, colors, hex, leader, move, skin, turn, type Pose, type RGB, type Voxel } from '@mob/ui/voxel/model';
import { add, arc, block, glyph, QUESTION, rotate, TICK_MARK, type Facing, type Vec } from '@mob/ui/voxel/motion';
import type { Frame } from '@mob/ui/voxel/project';

/** Where a task is along its row. */
export type Place = 'build' | 'verify' | 'review' | 'ready' | 'stuck';

export type StudioRow = {
	/** checks and review say which stations the task's stages have. */
	checks: boolean;
	review: boolean;
	/** place is where the task is now (undefined: not started), and from where it came. */
	place?: Place;
	from?: Place;
	/** fixing: back at the desk with what the checks or the review found. */
	fixing?: boolean;
	/** since is how many seconds it has been there. */
	since: number;
};

/** waiting: the plan waits for your approval. */
export type Studio = { rows: StudioRow[]; waiting: boolean };

const WIDTH = 110, ROW = 20;
const WALK = 1.2; // seconds to walk between stations
export const stations = { desk: 26, checks: 52, review: 76, reviewer: 84, tray: 102 };
export const rowZ = (i: number) => 9 + i * ROW;
const depth = (rows: number) => (Math.max(rows, 1) - 1) * ROW + 22;

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

// The room and its furniture change only with the colour scheme and the rows' stations.
const built = new Map<string, Voxel[]>();
function room(rows: StudioRow[]): Voxel[] {
	const key = `${theme()} ${rows.map((r) => `${+r.checks}${+r.review}`).join()}`;
	const cached = built.get(key);
	if (cached) return cached;
	const c = rooms[theme()];
	const deep = depth(rows.length);
	const v: Voxel[] = [];
	for (let x = 0; x < WIDTH; x += 4) for (let z = 0; z < deep; z += 4) {
		const lane = rows.some((_, i) => z <= rowZ(i) && rowZ(i) < z + 4);
		v.push(big(x, -4, z, 4, lane ? c.lane : ((x + z) / 4) % 2 ? c.a : c.b));
	}
	for (let i = 0; i < WIDTH; i += 2) for (let y = 0; y < 10; y += 2) v.push(big(i, y, -2, 2, y === 8 ? c.top : c.wall));
	for (let i = 0; i < deep; i += 2) for (let y = 0; y < 10; y += 2) v.push(big(-2, y, i, 2, y === 8 ? c.top : c.wall));
	rows.forEach((row, i) => {
		const z = rowZ(i);
		// The agent's desk, in front of its seat, with a monitor facing it.
		const d = stations.desk;
		v.push(...box(d - 4, d + 4, 4, 4, z + 4, z + 6, furniture.table), ...box(d - 4, d + 4, 4, 4, z + 6, z + 6, furniture.edge));
		for (const lx of [d - 4, d + 4]) v.push(...box(lx, lx, 0, 3, z + 6, z + 6, furniture.leg));
		v.push(...box(d - 1, d + 1, 5, 7, z + 6, z + 6, furniture.screen), [d - 0.5, 6.4, z + 5.5, ...colors.lime, 0.5, 0.4]);
		// The checks booth: glass on three sides, open to the row.
		if (row.checks) {
			const b = stations.checks;
			for (const [x, zz] of [[b - 5, z - 5], [b + 5, z - 5], [b - 5, z + 5], [b + 5, z + 5]]) v.push(...box(x, x, 0, 10, zz, zz, furniture.post));
			for (let y = 1; y <= 10; y += y === 10 ? 1 : 3) {
				const s = y === 10 ? 1 : 0.35;
				for (let x = b - 4; x < b + 5; x += y === 10 ? 1 : 2) v.push([x, y, z - 5, ...colors.cyan, 0.35, s], [x, y, z + 5, ...colors.cyan, 0.35, s]);
				for (let zz = z - 4; zz < z + 5; zz += y === 10 ? 1 : 2) v.push([b + 5, y, zz, ...colors.cyan, 0.35, s]);
			}
			v.push(...box(b - 4, b + 4, -1, -1, z - 4, z + 4, c.booth));
		}
		// The reviewer's lectern.
		if (row.review) v.push(...box(stations.reviewer - 1, stations.reviewer + 1, 0, 4, z + 3, z + 5, furniture.table), ...box(stations.reviewer - 2, stations.reviewer + 2, 5, 5, z + 3, z + 5, furniture.edge));
		// Your tray at the end of the row.
		const t = stations.tray;
		v.push(...box(t - 3, t + 3, 0, 3, z - 3, z + 3, furniture.tray), ...box(t - 3, t + 3, 4, 4, z - 3, z + 3, furniture.table));
	});
	built.set(key, v);
	return v;
}

// Each row's agent keeps its own coat, and its reviewer another.
const coat = (i: number) => skin(11 + i * 18);
const reviewerCoat = (i: number) => skin(61 + i * 12);

const spot = (place: Place | undefined, z: number): Vec =>
	place === 'verify' ? [stations.checks, 0, z] : place === 'review' ? [stations.review, 0, z] : [stations.desk, 0, z];

type Calf = { at: Vec; facing: Facing; pose: Pose; frame: number; carry?: RGB };

// Where the row's agent is and what it is doing.
function agent(row: StudioRow, z: number, t: number, i: number): Calf {
	const to = spot(row.place, z);
	const from = row.from ? spot(row.from, z) : to;
	if (row.since < WALK && from[0] !== to[0]) {
		const p = row.since / WALK;
		const forward = to[0] > from[0];
		return { at: [Math.round(from[0] + (to[0] - from[0]) * p), 0, z], facing: forward ? 1 : 3, pose: forward && row.place !== 'ready' ? 'carry' : 'walk', frame: Math.floor(row.since * 8), carry: forward && row.place !== 'ready' ? colors.cyan : undefined };
	}
	const frame = Math.floor(t * 6);
	switch (row.place) {
		case 'build':
			return { at: to, facing: 0, pose: Math.floor(t / 3 + i) % 4 ? 'type' : 'idle', frame };
		case 'verify':
			return { at: to, facing: 1, pose: 'hold', frame };
		case 'review':
			return { at: to, facing: 1, pose: row.since - WALK < 0.8 ? 'throw' : 'idle', frame };
		case 'stuck':
			return { at: from, facing: 0, pose: 'catch', frame };
		default:
			return { at: to, facing: 0, pose: 'idle', frame };
	}
}

const BANG = ['#', '#', '#', '.', '#'];

/** studioVoxels draws the studio at time `t` (seconds, for idle motion). */
export function studioVoxels(s: Studio, t: number): Voxel[] {
	const v: Voxel[] = [...room(s.rows)];
	// Mob, the gold calf, holds the plan until you decide, then hands each task to its desk.
	const boss: Vec = [7, 0, 9 + ((s.rows.length - 1) * ROW) / 2];
	v.push(...move(turn(calf(leader, s.waiting ? 'hold' : 'idle', Math.floor(t * 6)), 1), boss[0], 0, boss[2]));
	if (s.waiting) v.push(block(add(boss, [3, 6.4, 0]), colors.amber, 2, 1), ...glyph(QUESTION, [boss[0], 18, boss[2]], colors.amber));
	s.rows.forEach((row, i) => {
		const z = rowZ(i);
		const deskTop: Vec = [stations.desk, 6, z + 5];
		const a = agent(row, z, t, i);
		v.push(...move(turn(calf(coat(i), a.pose, a.frame), a.facing), a.at[0], 0, a.at[2]));
		if (a.carry) v.push(block(add(a.at, rotate([0, 6.4, 3.6], a.facing)), a.carry, 1.4, 0.8));
		const arrived = row.since >= WALK || !row.from;
		// The hand-off: a block flies from Mob to the desk as the task starts.
		const handing = row.place === 'build' && !row.from && row.since < 1;
		if (handing) v.push(block(arc(add(boss, [3, 7, 0]), deskTop, row.since, 10), colors.cyan, 1.4, 1));
		// On the desk: work in progress, cyan; something to fix, amber, after an "!" on the way back.
		if (row.place === 'build' && !handing) v.push(block(deskTop, row.fixing ? colors.amber : [colors.cyan, colors.lime][Math.floor(t * 3) % 2], 1.4, 0.8));
		if (row.place === 'build' && row.fixing && row.since < WALK + 1) v.push(...glyph(BANG, [a.at[0], 18, z], colors.amber));
		// In the booth the work fizzes while the checks run.
		if (row.place === 'verify' && arrived) {
			const hands = add(a.at, rotate([0, 7.4, 3], 1));
			v.push(block(hands, [colors.cyan, colors.violet, colors.amber][Math.floor(t * 5) % 3], 1.6, 1));
			for (let k = 0; k < 4; k++) {
				const p = (t * 1.3 + k / 4) % 1;
				v.push([hands[0] + Math.round(Math.sin(k * 2 + t * 3) * 3), hands[1] + p * 4, hands[2] + Math.round(Math.cos(k * 2 + t * 2) * 3), ...colors.cyan, 1, 0.4]);
			}
		}
		// The reviewer reads the work at its lectern.
		if (row.review) {
			const reviewing = row.place === 'review' && arrived;
			v.push(...move(turn(calf(reviewerCoat(i), reviewing ? 'hold' : 'idle', Math.floor(t * 6)), 3), stations.reviewer + 4, 0, z));
			if (reviewing) v.push(block([stations.reviewer, 6.4, z + 4], colors.cyan, 1.4, 0.8), ...glyph(['#.#.#'], [stations.reviewer + 4, 17, z], colors.violet));
		}
		// Needs you: a hand up and a question.
		if (row.place === 'stuck') v.push(...glyph(QUESTION, [a.at[0], 18, z], colors.amber));
		// Ready: the work lands in your tray and stays there, lit.
		if (row.place === 'ready') {
			const from: Vec = row.from === 'review' ? [stations.reviewer, 7, z + 4] : row.from === 'verify' ? [stations.checks, 8, z] : deskTop;
			const tray: Vec = [stations.tray, 5.6, z];
			const flying = !!row.from && row.since < 1;
			v.push(block(flying ? arc(from, tray, row.since, 8) : tray, colors.lime, 1.8, 1));
			if (!flying) v.push(...glyph(TICK_MARK, [stations.tray, 14, z], colors.lime));
		}
	});
	return v;
}

/** studioFrame fits the room of `rows` rows to a canvas. */
export function studioFrame(rows: number) {
	return (width: number, height: number): Frame => {
		const deep = depth(rows);
		const s = Math.SQRT1_2, r = Math.sqrt(6);
		const spanX = (WIDTH + deep) * s, spanY = (WIDTH + deep) / r + 20;
		const unit = Math.min(width / (spanX + 4), height / (spanY + 4));
		return {
			unit,
			x: width / 2 - ((WIDTH - deep) / 2) * s * unit,
			y: height / 2 - ((WIDTH + deep) / r / 2 - 10) * unit,
			backdrop: theme() === 'light' ? hex('#f4f3ee') : [0, 0, 0],
		};
	};
}
