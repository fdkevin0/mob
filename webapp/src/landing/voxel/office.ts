import { alarm, calf, colors, desk, hex, lying, move, skin, snore, tea, turn, type CalfStyle, type Pose, type RGB, type Voxel } from './model';
import { add, block, random, rotate, type Facing, type Vec } from './motion';

// The hero background: an open-plan office of calves, run as a small
// simulation. Each calf works at its desk, then wanders off to high-five a
// colleague, hand over a block of work, fetch a milk tea or nap on the sofa,
// and walks back along the aisles. Everything is seeded, so the office plays
// out the same way on every visit.

const COLS = 11, ROWS = 6, CALVES = 46;
const W = 174, D = 104; // floor size in voxels, x by z
const CORRIDOR = 158; // the walkway that joins the aisles
const SPEED = 8; // voxels per second
const TICK = 1 / 20;

type P = [number, number]; // x, z on the floor
type Spot = { x: number; z: number; door: P; facing: Facing; user?: Agent };

const seatX = (i: number) => 14 + 13 * i;
const seatZ = (j: number) => 14 + 15 * j;

const seats: Spot[] = [];
for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) seats.push({ x: seatX(i), z: seatZ(j), door: [seatX(i), seatZ(j) - 8], facing: 0 });
const bar: Spot[] = [14, 22, 30, 38].map(z => ({ x: 161, z, door: [CORRIDOR, z], facing: 1 }));
const sofa: Spot[] = [74, 88].map(z => ({ x: 163, z, door: [CORRIDOR, z], facing: 1 }));
// Visitors stand beside a desk, between it and the next one.
const beside = (s: Spot): Spot => ({ x: s.x + 6, z: s.z, door: [s.x + 6, s.door[1]], facing: 3 });

// Along the aisle, up or down the corridor, along the other aisle, then in.
function route(from: Spot, to: Spot): P[] {
	const points: P[] = from.door[1] === to.door[1]
		? [from.door, to.door, [to.x, to.z]]
		: [from.door, [CORRIDOR, from.door[1]], [CORRIDOR, to.door[1]], to.door, [to.x, to.z]];
	return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

type Errand = 'visit' | 'deliver' | 'tea' | 'nap' | 'home';

type Agent = {
	style: CalfStyle;
	home: Spot;
	at: P;
	facing: Facing;
	walked: number;
	state: 'work' | 'walk' | 'busy' | 'nap';
	until: number;
	path: P[];
	errand: Errand;
	where: Spot; // the spot it is at or heading to
	target?: Agent;
	carry?: 'tea' | 'block';
	pose?: Pose;
	poseFacing?: Facing;
	poseUntil: number;
	spark: number;
	deskBlock: number;
	deskTea: number;
};

class Office {
	time = 0;
	rand = random(7);
	agents: Agent[] = [];

	constructor() {
		for (const s of [...bar, ...sofa]) s.user = undefined;
		const free = [...seats];
		for (let n = 0; n < CALVES; n++) {
			const home = free.splice(Math.floor(this.rand() * free.length), 1)[0];
			this.agents.push({
				style: skin(n * 7 + 3), home, at: [home.x, home.z], facing: 0, walked: 0,
				state: 'work', until: 1 + this.rand() * 9, path: [], errand: 'home', where: home,
				poseUntil: 0, spark: 0, deskBlock: this.rand() < 0.4 ? 6 : 0, deskTea: 0,
			});
		}
	}

	advance(to: number) {
		if (to < this.time) Object.assign(this, new Office());
		// After a long pause (a hidden tab) skip ahead rather than replay it.
		if (to - this.time > 20) this.time = to - 20;
		while (this.time + TICK <= to) { this.time += TICK; this.agents.forEach(a => this.step(a)); }
	}

	go(a: Agent, to: Spot, errand: Errand) {
		a.path = route(a.where, to);
		a.where = to;
		a.errand = errand;
		a.state = 'walk';
	}

	step(a: Agent) {
		const t = this.time;
		if (a.state === 'walk') return this.walk(a);
		if (t < a.until) return;
		if (a.state === 'nap') {
			// Wakes with a start and heads back.
			a.state = 'busy'; a.until = t + 0.8; a.pose = 'startle'; a.poseFacing = 1; a.poseUntil = a.until;
			return;
		}
		if (a.state === 'busy') {
			if (a.errand === 'tea') a.carry = 'tea';
			if (a.where.user === a) a.where.user = undefined;
			return this.go(a, a.home, 'home');
		}
		// Done working for now: pick an errand.
		const r = this.rand();
		const colleague = () => {
			const at = this.agents.filter(b => b !== a && b.state === 'work');
			return at[Math.floor(this.rand() * at.length)];
		};
		if (r < 0.5) {
			const b = colleague();
			if (b) { a.target = b; a.carry = r < 0.22 ? 'block' : undefined; return this.go(a, beside(b.home), r < 0.22 ? 'deliver' : 'visit'); }
		} else if (r < 0.75) {
			const slot = bar.find(s => !s.user);
			if (slot) { slot.user = a; return this.go(a, slot, 'tea'); }
		} else if (r < 0.86) {
			const slot = sofa.find(s => !s.user);
			if (slot) { slot.user = a; return this.go(a, slot, 'nap'); }
		}
		// Otherwise a stretch at the desk and back to work.
		a.pose = 'stretch'; a.poseFacing = 0; a.poseUntil = t + 1.4;
		a.until = t + 1.4 + 4 + this.rand() * 8;
	}

	walk(a: Agent) {
		let left = SPEED * TICK;
		a.walked += left;
		while (left > 0 && a.path.length) {
			const [tx, tz] = a.path[0];
			const dx = tx - a.at[0], dz = tz - a.at[1];
			const dist = Math.abs(dx) + Math.abs(dz);
			if (dx || dz) a.facing = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 0 : 2);
			if (dist <= left) { a.at = [tx, tz]; a.path.shift(); left -= dist; }
			else { a.at = [a.at[0] + Math.sign(dx) * Math.min(left, Math.abs(dx)), a.at[1] + Math.sign(dz) * Math.min(left, Math.abs(dz))]; left = 0; }
		}
		if (!a.path.length) this.arrive(a);
	}

	arrive(a: Agent) {
		const t = this.time;
		a.facing = a.where.facing;
		const b = a.target;
		switch (a.errand) {
			case 'visit': case 'deliver':
				a.state = 'busy'; a.until = t + 1.3;
				if (b && b.state === 'work') {
					const pose: Pose = a.errand === 'visit' ? 'high-five' : 'catch';
					a.pose = a.errand === 'visit' ? 'high-five' : 'throw'; a.poseFacing = 3; a.poseUntil = t + 1;
					b.pose = pose; b.poseFacing = 1; b.poseUntil = t + 1;
					if (a.errand === 'visit') a.spark = t + 0.5;
					else { b.deskBlock = t + 7; a.carry = undefined; }
				}
				break;
			case 'tea':
				a.state = 'busy'; a.until = t + 2.6; a.pose = 'drink'; a.poseFacing = 1; a.poseUntil = a.until;
				break;
			case 'nap':
				a.state = 'nap'; a.until = t + 6 + this.rand() * 5;
				break;
			case 'home':
				a.state = 'work'; a.until = t + 4 + this.rand() * 9;
				if (a.carry === 'tea') a.deskTea = t + 9;
				a.carry = undefined; a.target = undefined;
				break;
		}
	}
}

// Fixed scenery, built once: floor, walls, desks, the tea bar, the sofa.
const big = (x0: number, y0: number, z0: number, s: number, c: RGB, glow = 0): Voxel => [x0 + s / 2 - 0.5, y0 + s / 2 - 0.5, z0 + s / 2 - 0.5, ...c, glow, s];

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: RGB, glow = 0): Voxel[] {
	const v: Voxel[] = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) v.push([x, y, z, ...c, glow, 1]);
	return v;
}

const palette = {
	floorA: hex('#1b1f24'), floorB: hex('#181b20'), lane: hex('#20242a'),
	wall: hex('#23272e'), wallTop: hex('#2c313a'), window: hex('#2b5560'),
	screen: hex('#0f1114'), board: hex('#d9dccf'), counter: hex('#4a3a30'), counterTop: hex('#6d5646'),
	sofa: hex('#3c4a7a'), sofaSeat: hex('#5b6bb0'), cushion: hex('#7d8bd0'), edge: hex('#14171b'), leaf: hex('#4f8f4a'), pot: hex('#6d5646'),
};

function scenery(): Voxel[] {
	const v: Voxel[] = [];
	const aisles = new Set(seats.map(s => s.door[1]));
	for (let x = 0; x < W; x += 4) for (let z = 0; z < D; z += 4) {
		const lane = x >= CORRIDOR - 4 && x < CORRIDOR + 4 || [...aisles].some(a => z <= a && a < z + 4);
		const edge = x + 4 >= W || z + 4 >= D;
		v.push(big(x, -4, z, 4, edge ? palette.edge : lane ? palette.lane : ((x + z) / 4) % 2 ? palette.floorA : palette.floorB));
	}
	// Two back walls with windows, and a whiteboard.
	for (let x = 0; x < W; x += 2) for (let y = 0; y < 14; y += 2) {
		const win = y >= 4 && y < 10 && x % 16 >= 4 && x % 16 < 12;
		v.push(big(x, y, -2, 2, win ? palette.window : y === 12 ? palette.wallTop : palette.wall, win ? 0.35 : 0));
	}
	for (let z = 0; z < D; z += 2) for (let y = 0; y < 14; y += 2) {
		const win = y >= 4 && y < 10 && z % 16 >= 4 && z % 16 < 12;
		v.push(big(-2, y, z, 2, win ? palette.window : y === 12 ? palette.wallTop : palette.wall, win ? 0.35 : 0));
	}
	for (let x = 40; x < 56; x++) for (let y = 5; y < 11; y++) {
		const ink = (y === 7 && x % 3 !== 0 && x < 50) ? colors.cyan : (y === 9 && x > 43 && x < 53) ? colors.amber : palette.board;
		v.push([x, y, -0.4, ...ink, 0, 1]);
	}
	// Desks with a monitor whose screen faces the calf; a lime edge lights it.
	for (const s of seats) {
		v.push(...move(desk(), s.x, 0, s.z + 3));
		v.push(...box(s.x - 1, s.x + 1, 5, 6, s.z + 4, s.z + 4, palette.screen));
		v.push(...box(s.x - 1, s.x + 1, 7, 7, s.z + 4, s.z + 4, colors.lime, 0.5).map(p => [p[0], p[1] - 0.6, p[2], p[3], p[4], p[5], p[6], 0.4] as Voxel));
	}
	// The milk tea bar along the right, with cups lined up on it.
	v.push(...box(164, 167, 0, 3, 8, 44, palette.counter));
	v.push(...box(164, 167, 4, 4, 8, 44, palette.counterTop));
	for (let z = 10; z < 44; z += 3) v.push(...tea(166, 5, z));
	// A sofa at the front right, and plants in the corners.
	v.push(...box(160, 170, 0, 1, 68, 94, palette.sofa));
	for (let z = 68; z <= 94; z++) v.push([160, 2, z, ...(Math.floor((z - 68) / 7) % 2 ? palette.sofaSeat : palette.cushion), 0, 1]);
	v.push(...box(161, 168, 2, 2, 68, 94, palette.sofaSeat));
	v.push(...box(169, 170, 2, 6, 68, 94, palette.sofa));
	v.push(...box(160, 170, 2, 4, 67, 67, palette.sofa), ...box(160, 170, 2, 4, 95, 95, palette.sofa));
	for (const [x, z] of [[3, 3], [W - 6, 3], [3, D - 6]] as P[]) {
		v.push(...box(x, x + 1, 0, 1, z, z + 1, palette.pot));
		for (let y = 2; y < 7; y++) v.push(...box(x - (y % 2), x + 1 + (y % 2), y, y, z - (y % 2), z + 1 + (y % 2), palette.leaf));
	}
	return v;
}

const fixed = scenery();
const office = new Office();

function calfVoxels(a: Agent, t: number): Voxel[] {
	const x = Math.round(a.at[0]), z = Math.round(a.at[1]);
	if (a.state === 'nap') {
		const rise = (t * 0.8) % 1.6;
		return [...move(turn(lying(calf(a.style, 'lie')), 1), x + 4, 3, z), ...snore(x - 6, 9 + rise * 2, z, 0.45)];
	}
	const posed = t < a.poseUntil && a.pose;
	const walking = a.state === 'walk';
	const pose: Pose = posed ? a.pose! : walking ? (a.carry ? 'carry' : 'walk') : a.state === 'work' ? (Math.floor(t / 3 + a.home.x) % 4 ? 'type' : 'idle') : 'idle';
	const facing = (posed ? a.poseFacing : undefined) ?? a.facing;
	const frame = walking ? Math.floor(a.walked) : Math.floor(t * 6);
	const hop = walking && Math.floor(a.walked / 2) % 2 ? 1 : 0;
	const v = move(turn(calf(a.style, pose, frame), facing), x, hop, z);
	const here: Vec = [x, hop, z];
	if (a.carry === 'block') v.push(block(add(here, rotate([0, 6.4, 3.6], facing as Facing)), colors.lime, 1.4, 0.8));
	if (a.carry === 'tea' && pose !== 'drink') { const [cx, cy, cz] = add(here, rotate([0, 6, 3], facing as Facing)); v.push(...tea(cx, cy, cz)); }
	if (pose === 'drink') { const [cx, cy, cz] = add(here, rotate([2, 8, 3], facing as Facing)); v.push(...tea(cx, cy, cz)); }
	if (pose === 'startle') v.push(...alarm(x, 15, z));
	if (t < a.spark) {
		const [sx, sy, sz] = add(here, rotate([3, 11, 0], facing as Facing));
		for (const [dx, dy] of [[0, 1.2], [0, -1.2], [1.2, 0], [-1.2, 0]]) v.push([sx + dx * 0.5, sy + dy, sz + dx, ...colors.amber, 1, 0.5]);
		v.push([sx, sy, sz, ...colors.white, 1, 0.8]);
	}
	return v;
}

function deskVoxels(a: Agent, t: number): Voxel[] {
	const v: Voxel[] = [];
	const s = a.home;
	if (t < a.deskBlock) v.push(block([s.x, 5.4, s.z + 3], [colors.cyan, colors.lime, colors.amber][Math.floor(t * 4) % 3], 1.4, 0.8));
	if (t < a.deskTea) v.push(...tea(s.x + 2, 5, s.z + 3));
	return v;
}

export function officeVoxels(time: number): Voxel[] {
	office.advance(time);
	const t = office.time;
	const v: Voxel[] = [...fixed];
	for (const a of office.agents) v.push(...deskVoxels(a, t), ...calfVoxels(a, t));
	return v;
}

// Small calves: a voxel is a couple of rendered pixels, and the office sits
// in the middle of the hero, under the title.
export function officeFrame(width: number, height: number) {
	const unit = Math.min(2.6, Math.max(1.5, width / 300));
	const cx = W / 2, cz = D / 2;
	return { unit, x: width / 2 - ((cx - cz) * Math.SQRT1_2) * unit, y: height * 0.56 - ((cx + cz) / Math.sqrt(6)) * unit };
}
