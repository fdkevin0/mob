import { alarm, calf, colors, hex, leader, lying, move, skin, snore, tea, turn, type CalfStyle, type Pose, type RGB, type Voxel } from './model';
import { add, arc, block, random, rotate, type Facing, type Vec } from './motion';
import { project } from './project';

// The hero background: a square open-plan office of calves, run as a small
// simulation. The floor is a 3 x 3 grid of cells, each holding a randomly
// chosen group of shared desks (long benches either way round, or a small
// pod of four) with no partitions. About seven in ten seats get a calf. Each
// calf spends most of its time working at its desk (about four in five are
// seated at any moment). Now and then it puts its hand up for the leader's
// nod, or walks the lanes between the cells to high-five a colleague nearby,
// hand over a block of work, fetch a milk tea or a coffee, pin a note on the
// whiteboard, try something out in the glass booth or nap on the sofa. Each page load
// lays out a new office. The landing page asks what a calf is doing to link
// it to a feature, and plays a scripted task across the floor (`setStory`).

const SIZE = 120; // the floor is SIZE x SIZE voxels
const OCCUPANCY = 0.7; // calves per seat
const SPEED = 10; // voxels per second
const TICK = 1 / 20;
const LANES = [4, 35, 66, 97]; // walkways between cells, both ways round
const DESK_TOP = 4;

type P = [number, number]; // x, z on the floor
type Spot = { x: number; z: number; facing: Facing; out: P; lane: number; user?: Agent };

const opposite = (f: Facing) => ((f + 2) % 4) as Facing;
const nearest = (v: number) => LANES.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// Out of the seat, along to the cell's lane, across on the nearest cross lane,
// down the target's lane and in. Lanes never cross a desk.
function route(from: Spot, to: Spot): P[] {
	const cross = nearest(from.out[1]);
	const points: P[] = [from.out, [from.lane, from.out[1]], [from.lane, cross], [to.lane, cross], [to.lane, to.out[1]], to.out, [to.x, to.z]];
	return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

const palette = {
	floorA: hex('#1b1f24'), floorB: hex('#181b20'), lane: hex('#21252b'), edge: hex('#14171b'),
	wall: hex('#23272e'), wallTop: hex('#2c313a'), window: hex('#2b5560'),
	table: hex('#8a7a66'), tableEdge: hex('#6c5f50'), leg: hex('#3a4048'),
	screen: hex('#0f1114'), board: hex('#d9dccf'), counter: hex('#4a3a30'), counterTop: hex('#6d5646'),
	machine: hex('#b0413e'), steel: hex('#a7adb5'), coffee: hex('#5a3a26'), mug: hex('#f2efe8'),
	glass: hex('#62e0ea'), post: hex('#3a4f57'), boothFloor: hex('#16262b'),
	sofa: hex('#3c4a7a'), sofaSeat: hex('#5b6bb0'), cushion: hex('#7d8bd0'), leaf: hex('#4f8f4a'), pot: hex('#6d5646'),
};

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: RGB, glow = 0): Voxel[] {
	const v: Voxel[] = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) v.push([x, y, z, ...c, glow, 1]);
	return v;
}
const big = (x0: number, y0: number, z0: number, s: number, c: RGB, glow = 0): Voxel => [x0 + s / 2 - 0.5, y0 + s / 2 - 0.5, z0 + s / 2 - 0.5, ...c, glow, s];
// Swaps x and z about a centre, to turn a desk group a quarter round.
const swap = (v: Voxel[], cx: number, cz: number): Voxel[] => v.map(p => [cx + (p[2] - cz), p[1], cz + (p[0] - cx), p[3], p[4], p[5], p[6], p[7]]);

function plant(x: number, z: number): Voxel[] {
	const v = box(x, x + 1, 0, 1, z, z + 1, palette.pot);
	for (let y = 2; y < 7; y++) v.push(...box(x - (y % 2), x + 1 + (y % 2), y, y, z - (y % 2), z + 1 + (y % 2), palette.leaf));
	return v;
}

// A shared table with seats along both long sides and monitors back to back
// down the middle. Built along x; `turned` lays it along z instead.
function bench(cx: number, cz: number, perSide: number, turned: boolean, cell: [number, number, number, number]) {
	const half = perSide * 4;
	let v: Voxel[] = [
		...box(cx - half, cx + half - 1, DESK_TOP, DESK_TOP, cz - 2, cz + 1, palette.table),
		...box(cx - half, cx + half - 1, DESK_TOP, DESK_TOP, cz - 2, cz - 2, palette.tableEdge),
	];
	for (const lx of [cx - half, cx + half - 1]) for (const lz of [cz - 2, cz + 1]) v.push(...box(lx, lx, 0, DESK_TOP - 1, lz, lz, palette.leg));
	const seats: Spot[] = [];
	for (let k = 0; k < perSide; k++) {
		const sx = cx - half + 4 + k * 8;
		v.push(...box(sx - 1, sx + 1, 5, 6, cz - 1, cz - 1, palette.screen), ...box(sx - 1, sx + 1, 5, 6, cz, cz, palette.screen));
		v.push([sx - 0.5, 7 - 0.6, cz - 0.5, ...colors.lime, 0.5, 0.4]);
		seats.push({ x: sx, z: cz - 6, facing: 0, out: [sx, cz - 11], lane: 0 }, { x: sx, z: cz + 5, facing: 2, out: [sx, cz + 10], lane: 0 });
	}
	const [left, right] = [cell[0], cell[1]];
	if (!turned) {
		for (const s of seats) s.lane = nearest(s.x) === left || nearest(s.x) === right ? nearest(s.x) : left;
		return { voxels: v, seats };
	}
	// Turned: x and z swap, so seats face +x or -x and leave sideways.
	v = swap(v, cx, cz);
	for (const s of seats) {
		const [x, z] = [cx + (s.z - cz), cz + (s.x - cx)];
		const [ox, oz] = [cx + (s.out[1] - cz), cz + (s.out[0] - cx)];
		s.x = x; s.z = z; s.out = [ox, oz];
		s.facing = s.facing === 0 ? 1 : 3;
		s.lane = s.facing === 1 ? left : right;
	}
	return { voxels: v, seats };
}

// Lays out the office from a seed: one desk group per cell, jittered a little.
function layout(seed: number) {
	const rand = random(seed);
	const voxels: Voxel[] = [];
	const seats: Spot[] = [];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
		const cell: [number, number, number, number] = [LANES[i], LANES[i + 1], LANES[j], LANES[j + 1]];
		const cx = Math.round((cell[0] + cell[1]) / 2 + (rand() - 0.5) * 3);
		const cz = Math.round((cell[2] + cell[3]) / 2 + (rand() - 0.5) * 4);
		const r = rand();
		const group = r < 0.4 ? bench(cx, cz, 3, false, cell) : r < 0.8 ? bench(cx, cz, 3, true, cell) : bench(cx, cz, 2, rand() < 0.5, cell);
		voxels.push(...group.voxels);
		seats.push(...group.seats);
		if (r >= 0.8) voxels.push(...plant(cell[1] - 6, cell[3] - 6));
	}
	return { voxels, seats };
}

// The kitchen strip along the right: a milk tea bar, a coffee machine, and a
// sofa in the front corner.
const KITCHEN = 108;
const bar: Spot[] = [12, 20, 28].map(z => ({ x: KITCHEN, z, facing: 1, out: [KITCHEN, z], lane: 97 }));
const coffee: Spot[] = [48, 56].map(z => ({ x: KITCHEN, z, facing: 1, out: [KITCHEN, z], lane: 97 }));
const sofa: Spot[] = [90, 104].map(z => ({ x: 110, z, facing: 1, out: [110, z], lane: 97 }));
// The whiteboard on the back wall, and the glass booth in the front strip.
const board: Spot[] = [45, 51].map(x => ({ x, z: 3, facing: 2, out: [x, 4], lane: nearest(x) }));
const BOOTH = { x0: 12, x1: 30, z0: 102, z1: 116, door: 21 };
const booth: Spot[] = [{ x: BOOTH.door, z: 110, facing: 0, out: [BOOTH.door, 99], lane: nearest(BOOTH.door) }];

function kitchen(): Voxel[] {
	const v: Voxel[] = [];
	v.push(...box(112, 115, 0, 3, 6, 62, palette.counter), ...box(112, 115, 4, 4, 6, 62, palette.counterTop));
	for (let z = 8; z < 34; z += 3) v.push(...tea(114, 5, z));
	// The coffee machine: a steel box with a glowing panel, a spout and mugs.
	v.push(...box(112, 115, 5, 11, 46, 52, palette.machine), ...box(112, 115, 12, 12, 46, 52, palette.steel));
	v.push(...box(111, 111, 8, 10, 47, 51, palette.steel), [110.6, 9, 48.5, ...colors.amber, 1, 0.6], [110.6, 9, 50, ...colors.lime, 1, 0.5]);
	v.push(...box(111, 111, 7, 7, 49, 49, palette.coffee));
	for (const z of [55, 57, 59]) v.push([113, 5, z, ...palette.mug, 0, 0.9], [113, 5.6, z, ...palette.coffee, 0, 0.7]);
	// Sofa, facing into the room.
	v.push(...box(108, 118, 0, 1, 84, 110, palette.sofa));
	for (let z = 84; z <= 110; z++) v.push([108, 2, z, ...(Math.floor((z - 84) / 7) % 2 ? palette.sofaSeat : palette.cushion), 0, 1]);
	v.push(...box(109, 116, 2, 2, 84, 110, palette.sofaSeat), ...box(117, 118, 2, 6, 84, 110, palette.sofa));
	v.push(...box(108, 118, 2, 4, 83, 83, palette.sofa), ...box(108, 118, 2, 4, 111, 111, palette.sofa));
	return v;
}

// Glass panes as a sparse lattice of small glowing cubes, with solid posts.
function glass(lit: boolean): Voxel[] {
	const { x0, x1, z0, z1, door } = BOOTH;
	const pane = palette.glass, k = lit ? 0.9 : 0.35;
	const v: Voxel[] = [];
	for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) v.push(...box(x, x, 0, 12, z, z, palette.post));
	for (let y = 1; y <= 12; y += y === 12 ? 1 : 3) {
		for (let x = x0 + 1; x < x1; x += y === 12 ? 1 : 2) {
			v.push([x, y, z1, ...pane, k, y === 12 ? 1 : 0.35]);
			if (Math.abs(x - door) > 2 || y > 9) v.push([x, y, z0, ...pane, k, y === 12 ? 1 : 0.35]);
		}
		for (let z = z0 + 1; z < z1; z += y === 12 ? 1 : 2) v.push([x0, y, z, ...pane, k, y === 12 ? 1 : 0.35], [x1, y, z, ...pane, k, y === 12 ? 1 : 0.35]);
	}
	v.push(...box(x0 + 1, x1 - 1, -1, -1, z0 + 1, z1 - 1, palette.boothFloor));
	return v;
}

function room(): Voxel[] {
	const v: Voxel[] = [];
	for (let x = 0; x < SIZE; x += 4) for (let z = 0; z < SIZE; z += 4) {
		const lane = LANES.some(l => (x <= l && l < x + 4) || (z <= l && l < z + 4));
		const edge = x + 4 >= SIZE || z + 4 >= SIZE;
		v.push(big(x, -4, z, 4, edge ? palette.edge : lane ? palette.lane : ((x + z) / 4) % 2 ? palette.floorA : palette.floorB));
	}
	for (let i = 0; i < SIZE; i += 2) for (let y = 0; y < 14; y += 2) {
		const win = y >= 4 && y < 10 && i % 16 >= 4 && i % 16 < 12;
		const c = win ? palette.window : y === 12 ? palette.wallTop : palette.wall;
		v.push(big(i, y, -2, 2, c, win ? 0.35 : 0), big(-2, y, i, 2, c, win ? 0.35 : 0));
	}
	for (let x = 40; x < 56; x++) for (let y = 5; y < 11; y++) {
		const ink = (y === 7 && x % 3 !== 0 && x < 50) ? colors.cyan : (y === 9 && x > 43 && x < 53) ? colors.amber : palette.board;
		v.push([x, y, -0.4, ...ink, 0, 1]);
	}
	v.push(...plant(3, 3), ...plant(3, SIZE - 6), ...plant(SIZE - 6, 3));
	return v;
}

type Errand = 'visit' | 'deliver' | 'tea' | 'coffee' | 'nap' | 'memo' | 'sandbox' | 'whip' | 'approve' | 'home';

// What a calf is up to, as the landing page names it.
export type Activity = 'work' | 'back' | 'deliver' | 'ask' | 'sandbox' | 'memo' | 'drink' | 'nap' | 'high-five' | 'lead';

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
	carry?: 'tea' | 'coffee' | 'block';
	pose?: Pose;
	poseFacing?: Facing;
	poseUntil: number;
	spark: number;
	deskBlock: number;
	deskCup?: 'tea' | 'coffee';
	deskCupUntil: number;
	leader?: boolean;
	whipAt: number;
	whipped?: boolean; // a napper the leader is already on the way to
	asking?: number; // when it put its hand up for the leader's nod
	claimed?: boolean; // the leader is on its way to that asker
	approvedAt: number;
};

const NOTE_COLORS = [colors.lime, colors.amber, colors.cyan, colors.violet];

// The scripted task the landing page plays across the floor, as Mob runs a
// team of coding agents: a message comes in to the leader, it hands the work
// to two desks and one of them passes a piece on to a colleague, one asks
// first, and the leader checks each desk's work before the result goes back
// out. The crew are the two working calves nearest the leader; the helper is
// the working calf nearest the second of them.
type Story = { step: number; since: number; crew: Agent[]; helper: Agent };
let story: Story | undefined;

class Office {
	time = 0;
	rand: () => number;
	agents: Agent[] = [];
	fixed: Voxel[];
	notes: { x: number; y: number; color: number }[] = [];

	constructor(readonly seed: number) {
		this.rand = random(seed);
		for (const s of [...bar, ...coffee, ...sofa, ...board, ...booth]) s.user = undefined;
		const { voxels, seats } = layout(seed);
		this.fixed = [...room(), ...kitchen(), ...voxels];
		// Seat about seven calves in ten, on randomly chosen seats.
		const free = [...seats];
		const count = Math.round(seats.length * OCCUPANCY);
		for (let n = 0; n < count; n++) {
			const home = free.splice(Math.floor(this.rand() * free.length), 1)[0];
			this.agents.push({
				style: skin(seed + n * 7 + 3), home, at: [home.x, home.z], facing: home.facing, walked: 0,
				state: 'work', until: 1 + this.rand() * 9, path: [], errand: 'home', where: home,
				poseUntil: 0, spark: 0, deskBlock: this.rand() < 0.4 ? 6 : 0, deskCupUntil: 0, whipAt: 0, approvedAt: -9,
			});
		}
		// The one gold calf: the leader keeps watch from the middle of the floor.
		const post: Spot = { x: 66, z: 41, facing: 0, out: [66, 41], lane: 66 };
		this.agents.push({
			style: leader, home: post, at: [post.x, post.z], facing: 0, walked: 0, state: 'work', until: 3, path: [],
			errand: 'home', where: post, poseUntil: 0, spark: 0, deskBlock: 0, deskCupUntil: 0, leader: true, whipAt: 0, approvedAt: -9,
		});
		for (let n = 0; n < 5; n++) this.note();
	}

	note() {
		this.notes.push({ x: 41 + Math.floor(this.rand() * 13), y: 5 + Math.floor(this.rand() * 5), color: Math.floor(this.rand() * NOTE_COLORS.length) });
		if (this.notes.length > 9) this.notes.shift();
	}

	advance(to: number) {
		if (to < this.time) Object.assign(this, new Office(this.seed));
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
			if (a.errand === 'tea' || a.errand === 'coffee') a.carry = a.errand;
			if (a.where.user === a) a.where.user = undefined;
			a.whipped = false;
			// An asker never left its desk: back to work, nod or no nod.
			if (a.where === a.home) { a.asking = undefined; a.claimed = false; a.state = 'work'; a.until = t + 10 + this.rand() * 15; return; }
			return this.go(a, a.home, 'home');
		}
		if (a.leader) return this.lead(a);
		// Done working for now: pick an errand.
		const r = this.rand();
		const take = (slots: Spot[], errand: Errand) => {
			const slot = slots.find(s => !s.user);
			if (!slot) return false;
			slot.user = a;
			this.go(a, slot, errand);
			return true;
		};
		// Mostly they stay at the desk; a few calves are up and about at a time,
		// and work goes to colleagues nearby.
		if (r < 0.1) {
			const near = this.agents
				.filter(b => b !== a && !b.leader && b.state === 'work')
				.sort((p, q) => Math.hypot(p.at[0] - a.at[0], p.at[1] - a.at[1]) - Math.hypot(q.at[0] - a.at[0], q.at[1] - a.at[1]))
				.slice(0, 6);
			const b = near[Math.floor(this.rand() * near.length)];
			if (b) {
				const deliver = r < 0.06;
				a.target = b; a.carry = deliver ? 'block' : undefined;
				return this.go(a, { x: b.home.out[0], z: b.home.out[1], facing: opposite(b.home.facing), out: b.home.out, lane: b.home.lane }, deliver ? 'deliver' : 'visit');
			}
		} else if (r < 0.14) { if (take(bar, 'tea')) return; }
		else if (r < 0.17) { if (take(coffee, 'coffee')) return; }
		else if (r < 0.19) { if (take(sofa, 'nap')) return; }
		else if (r < 0.23) { if (take(board, 'memo')) return; }
		else if (r < 0.27) { if (take(booth, 'sandbox')) return; }
		else if (r < 0.39) {
			// Hand up at the desk until the leader comes over to nod it through.
			a.state = 'busy'; a.asking = t; a.claimed = false; a.until = t + 16;
			a.pose = 'catch'; a.poseFacing = a.home.facing; a.poseUntil = a.until;
			return;
		}
		// Otherwise a stretch at the desk and back to work.
		a.pose = 'stretch'; a.poseFacing = a.home.facing; a.poseUntil = t + 1.4;
		a.until = t + 1.4 + 8 + this.rand() * 14;
	}

	// The leader walks over to anyone napping and cracks the whip; otherwise it
	// drops in on someone now and then, or grabs a coffee.
	lead(a: Agent) {
		const t = this.time;
		const napper = this.agents.find(b => b.state === 'nap' && !b.whipped);
		if (napper) {
			napper.whipped = true;
			napper.until = Math.max(napper.until, t + 30);
			a.target = napper;
			const z = napper.where.z;
			return this.go(a, { x: 99, z: z + 3, facing: 1, out: [99, z + 3], lane: 97 }, 'whip');
		}
		const asker = this.agents.find(b => b.asking !== undefined && !b.claimed && b !== story?.crew[0]);
		if (asker) {
			asker.claimed = true;
			asker.until = Math.max(asker.until, t + 30);
			a.target = asker;
			const h = asker.home;
			return this.go(a, { x: h.out[0], z: h.out[1], facing: opposite(h.facing), out: h.out, lane: h.lane }, 'approve');
		}
		const r = this.rand();
		const working = this.agents.filter(b => b !== a && b.state === 'work');
		if (r < 0.15 && working.length) {
			a.target = working[Math.floor(this.rand() * working.length)];
			const h = a.target.home;
			return this.go(a, { x: h.out[0], z: h.out[1], facing: opposite(h.facing), out: h.out, lane: h.lane }, 'visit');
		}
		if (r < 0.25) { const slot = coffee.find(s => !s.user); if (slot) { slot.user = a; return this.go(a, slot, 'coffee'); } }
		a.until = t + 2 + this.rand() * 3;
	}

	walk(a: Agent) {
		// The leader hurries when someone is asleep on the job.
		let left = (a.errand === 'whip' || a.errand === 'approve' ? 1.6 : 1) * SPEED * TICK;
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
					// The colleague turns round from its desk to meet the visitor.
					a.pose = a.errand === 'visit' ? 'high-five' : 'throw'; a.poseFacing = a.facing; a.poseUntil = t + 1;
					b.pose = a.errand === 'visit' ? 'high-five' : 'catch'; b.poseFacing = opposite(b.home.facing); b.poseUntil = t + 1;
					if (a.errand === 'visit') a.spark = t + 0.5;
					else { b.deskBlock = t + 7; a.carry = undefined; }
				}
				break;
			case 'tea': case 'coffee':
				a.state = 'busy'; a.until = t + 2.6; a.pose = 'drink'; a.poseFacing = 1; a.poseUntil = a.until;
				break;
			case 'nap':
				a.state = 'nap'; a.until = t + 18 + this.rand() * 8; a.whipped = false;
				break;
			case 'memo':
				a.state = 'busy'; a.until = t + 2.4; a.pose = 'catch'; a.poseFacing = a.facing; a.poseUntil = t + 1.6;
				this.note();
				break;
			case 'sandbox':
				a.state = 'busy'; a.until = t + 6; a.pose = 'hold'; a.poseFacing = a.facing; a.poseUntil = a.until;
				break;
			case 'approve':
				// A nod: the asker gets a tick and goes back to work.
				a.state = 'busy'; a.until = t + 1.2;
				if (b && b.asking !== undefined) { b.asking = undefined; b.approvedAt = t; b.until = t + 1.2; b.poseUntil = t; }
				break;
			case 'whip':
				// Two cracks of the whip; the napper jumps up on the first.
				a.state = 'busy'; a.whipAt = t; a.until = t + 1.4;
				if (b && b.state === 'nap') b.until = t + 0.35;
				break;
			case 'home':
				a.state = 'work'; a.until = t + 18 + this.rand() * 24;
				if (a.carry === 'tea' || a.carry === 'coffee') { a.deskCup = a.carry; a.deskCupUntil = t + 9; }
				a.carry = undefined; a.target = undefined;
				break;
		}
	}
}

// A new office on every load; `?office=<seed>` pins one.
const pinned = typeof location === 'undefined' ? NaN : Number(new URLSearchParams(location.search).get('office') ?? NaN);
const office = new Office(Number.isFinite(pinned) ? pinned : Math.floor(Math.random() * 100000));

function mug(x: number, y: number, z: number): Voxel[] {
	return [[x, y, z, ...palette.mug, 0, 0.9], [x, y + 0.6, z, ...palette.coffee, 0, 0.7]];
}

const QUESTION = ['.##.', '#..#', '..#.', '.#..', '....', '.#..'];
const TICK_MARK = ['.....#', '....#.', '#..#..', '.##...'];

// A small sign made of half-size cubes, facing the camera, centred above (x, y, z).
function glyph(rows: string[], [x, y, z]: Vec, color: RGB): Voxel[] {
	const v: Voxel[] = [];
	const w = rows[0].length;
	rows.forEach((row, iy) => [...row].forEach((c, ix) => {
		if (c !== '#') return;
		const d = (ix - w / 2) * 0.5;
		v.push([x + d * 0.7, y - iy * 0.55, z - d * 0.7, ...color, 1, 0.55]);
	}));
	return v;
}

function calfVoxels(a: Agent, t: number): Voxel[] {
	const x = Math.round(a.at[0]), z = Math.round(a.at[1]);
	if (a.state === 'nap') {
		const rise = (t * 0.8) % 1.6;
		return [...move(turn(lying(calf(a.style, 'lie')), 1), x + 7, 3, z), ...snore(x - 3, 9 + rise * 2, z, 0.45)];
	}
	const posed = t < a.poseUntil && a.pose;
	const walking = a.state === 'walk';
	const whipping = a.errand === 'whip' && a.state === 'busy';
	const pose: Pose = whipping ? (Math.floor((t - a.whipAt) / 0.3) % 2 ? 'whip-crack' : 'whip-up') : posed ? a.pose! : walking ? (a.carry ? 'carry' : 'walk') : a.state === 'work' && !a.leader ? (Math.floor(t / 3 + a.home.x) % 4 ? 'type' : 'idle') : 'idle';
	const facing = ((posed ? a.poseFacing : undefined) ?? a.facing) as Facing;
	const frame = walking ? Math.floor(a.walked) : Math.floor(t * 6);
	const hop = walking && Math.floor(a.walked / 2) % 2 ? 1 : 0;
	const v = move(turn(calf(a.style, pose, frame), facing), x, hop, z);
	const here: Vec = [x, hop, z];
	const cup = a.carry === 'tea' || a.errand === 'tea' ? tea : mug;
	if (a.carry === 'block') v.push(block(add(here, rotate([0, 6.4, 3.6], facing)), colors.lime, 1.4, 0.8));
	if ((a.carry === 'tea' || a.carry === 'coffee') && pose !== 'drink') v.push(...cup(...add(here, rotate([0, 6, 3], facing))));
	if (pose === 'drink') v.push(...cup(...add(here, rotate([2, 8, 3], facing))));
	if (pose === 'startle') v.push(...alarm(x, 15, z));
	if (a.asking !== undefined && a.state === 'busy') v.push(...glyph(QUESTION, [x, 17, z], colors.amber));
	if (t - a.approvedAt < 1.2) v.push(...glyph(TICK_MARK, [x, 17, z], colors.lime));
	if (a.errand === 'sandbox' && a.state === 'busy') {
		// Whatever it is trying out fizzes inside the glass, never past it.
		const [hx, hy, hz] = add(here, rotate([0, 7.6, 3.2], facing));
		v.push(block([hx, hy, hz], [colors.cyan, colors.violet, colors.amber][Math.floor(t * 5) % 3], 1.6, 1));
		for (let k = 0; k < 4; k++) {
			const p = (t * 1.3 + k / 4) % 1;
			v.push([hx + Math.round(Math.sin(k * 2 + t * 3) * 4), hy + p * 4, hz + Math.round(Math.cos(k * 2 + t * 2) * 3), ...colors.cyan, 1, 0.4]);
		}
	}
	if (t < a.spark) {
		const [sx, sy, sz] = add(here, rotate([3, 11, 0], facing));
		for (const [dx, dy] of [[0, 1.2], [0, -1.2], [1.2, 0], [-1.2, 0]]) v.push([sx + dx * 0.5, sy + dy, sz + dx, ...colors.amber, 1, 0.5]);
		v.push([sx, sy, sz, ...colors.white, 1, 0.8]);
	}
	return v;
}

// Things on a calf's desk: a block it is working on, a cup it brought back.
function deskVoxels(a: Agent, t: number): Voxel[] {
	const v: Voxel[] = [];
	const s = a.home;
	const at = (dx: number, y: number, dz: number) => add([s.x, 0, s.z], rotate([dx, y, dz], s.facing));
	if (t < a.deskBlock) v.push(block(at(0, 5.4, 4), [colors.cyan, colors.lime, colors.amber][Math.floor(t * 4) % 3], 1.4, 0.8));
	if (t < a.deskCupUntil) v.push(...(a.deskCup === 'tea' ? tea : mug)(...at(2.5, 5, 4)));
	return v;
}

// Where a calf holds things, and where its desk is.
const hands = (a: Agent): Vec => [a.at[0], 7, a.at[1]];
const deskTop = (a: Agent): Vec => add([a.home.x, 0, a.home.z], rotate([0, 6, 4], a.home.facing));
const OUTSIDE: Vec = [-16, 22, 44];

const dimmed = (v: Voxel[], k: number): Voxel[] => v.map(p => [p[0], p[1], p[2], p[3] * k, p[4] * k, p[5] * k, p[6] * k, p[7]]);
// The dimmed floor, cached at a handful of levels so a fade costs nothing.
const fixedDim = new Map<number, Voxel[]>();
const floorAt = (k: number) => {
	const level = Math.round(k * 20) / 20;
	if (level >= 1) return office.fixed;
	let v = fixedDim.get(level);
	if (!v) fixedDim.set(level, v = dimmed(office.fixed, level));
	return v;
};
// How far the story's spotlight and the feature highlight have faded in,
// from 0 to 1; the page sets these as it scrolls, so nothing snaps.
let fade = { story: 1, highlight: 1 };

function marker([x, , z]: Vec, t: number): Voxel[] {
	const bob = Math.floor(t * 3) % 2 ? 0.5 : 0;
	return [[x, 19 + bob, z, ...colors.lime, 1, 1.1], [x, 18 + bob, z, ...colors.lime, 1, 0.5]];
}

// The lines of the agent tree, drawn on the floor along the lanes: from the
// leader to each desk it handed work to, and from that desk to the helper.
// Light runs along a line while its work is under way; `grown` is how many
// voxels of it are drawn so far.
function trail(points: P[], grown: number, color: RGB, flowing: boolean, t: number, v: Voxel[]) {
	let walked = 0;
	for (let i = 1; i < points.length; i++) {
		const [ax, az] = points[i - 1], [bx, bz] = points[i];
		const length = Math.abs(bx - ax) + Math.abs(bz - az);
		for (let d = 0; d < length; d++, walked++) {
			if (walked >= grown) return;
			const lit = flowing && ((walked - t * 14) % 7 + 7) % 7 < 2;
			v.push([ax + (bx - ax) * d / length, -0.3, az + (bz - az) * d / length, ...color, lit ? 1 : 0.55, lit ? 0.9 : 0.6]);
		}
	}
}

// Plays one step of the story; returns the calves it is about.
function playStory(s: Story, t: number, v: Voxel[]): Agent[] {
	const boss = office.agents.find(a => a.leader)!;
	const { crew, helper } = s;
	const [asker, passer] = crew;
	const since = t - s.since;
	const p = since % 3.6;
	// Each line's colour, as the agent tree colours its status.
	const lines: { from: Agent; to: Agent; grown: number; color: RGB; flowing: boolean }[] = [];
	if (s.step >= 1) {
		const after = s.step > 1 ? Infinity : 0;
		crew.forEach((c, i) => lines.push({ from: boss, to: c, grown: after || (since - i * 0.5) * 80, color: colors.cyan, flowing: true }));
		lines.push({ from: passer, to: helper, grown: after || (since - 2.4) * 40, color: colors.cyan, flowing: true });
	}
	switch (s.step) {
		case 0: // a message flies in over the wall to the leader
			v.push(block(arc(OUTSIDE, hands(boss), p / 1.4, 10), colors.lime, 1.6, 1));
			return [boss];
		case 1: // the leader hands the work out, and one desk passes a piece on
			crew.forEach((c, i) => {
				const q = (p - i * 0.5) / 1.1;
				if (q > 0 && q < 1) v.push(block(arc(hands(boss), deskTop(c), q, 8), [colors.cyan, colors.violet][i], 1.4, 1));
				if (q >= 1) c.deskBlock = Math.max(c.deskBlock, t + 1);
			});
			if (p > 1.9 && p < 2.9) v.push(block(arc(deskTop(passer), deskTop(helper), (p - 1.9) / 1, 5), colors.amber, 1.2, 1));
			if (p >= 2.9) helper.deskBlock = Math.max(helper.deskBlock, t + 1);
			break;
		case 2: // one of them asks before doing something with side effects
			if (asker.state === 'work') { asker.pose = 'catch'; asker.poseFacing = asker.home.facing; asker.poseUntil = t + 0.2; }
			v.push(...glyph(p < 2.4 ? QUESTION : TICK_MARK, add(hands(asker), [0, 10, 0]), p < 2.4 ? colors.amber : colors.lime));
			if (p < 2.4) Object.assign(lines[0], { color: colors.amber, flowing: false });
			break;
		default: { // the leader checks each desk's work, then the result goes out
			const q = since % 4.4;
			crew.forEach((c, i) => {
				const from = i * 1.2;
				if (q > from && q < from + 1) v.push(block(arc(deskTop(c), hands(boss), q - from, 8), colors.lime, 1.4, 1));
				if (q >= from + 1 && q < from + 2.2) v.push(...glyph(TICK_MARK, add(hands(c), [0, 10, 0]), colors.lime));
				// Once checked, a line stays green.
				if (since >= from + 1) {
					Object.assign(lines[i], { color: colors.lime, flowing: false });
					if (c === passer) Object.assign(lines[2], { color: colors.lime, flowing: false });
				}
			});
			if (q > 2.8 && q < 4) v.push(block(arc(hands(boss), OUTSIDE, (q - 2.8) / 1.2, 10), colors.lime, 1.6, 1));
		}
	}
	for (const l of lines) trail(route(l.from.home, l.to.home), l.grown, l.color, l.flowing, t, v);
	return s.step === 2 ? [asker] : [boss, ...crew, helper];
}

let highlight: Activity[] | undefined;

export function officeVoxels(time: number): Voxel[] {
	office.advance(time);
	const t = office.time;
	const inBooth = booth[0].user?.state === 'busy';
	const v: Voxel[] = [];
	const extra: Voxel[] = [];
	const focus = story ? playStory(story, t, extra) : undefined;
	const floor = focus ? 1 - 0.65 * fade.story : 1;
	v.push(...floorAt(floor), ...(floor < 1 ? dimmed(glass(inBooth), floor) : glass(inBooth)));
	for (const n of office.notes) v.push([n.x, n.y, -0.2, ...NOTE_COLORS[n.color], 0.4, 0.9]);
	// Steam curling up from the coffee machine.
	for (let k = 0; k < 3; k++) {
		const p = (t * 0.6 + k / 3) % 1;
		v.push([113 + Math.round(Math.sin((p + k) * 6)) * 0.5, 13.5 + p * 6, 49, ...colors.white, 0.3, 0.9 - p * 0.5]);
	}
	for (const a of office.agents) {
		const lit = focus ? focus.includes(a) : !highlight || highlight.includes(activity(a));
		const own = [...deskVoxels(a, t), ...calfVoxels(a, t)];
		const k = focus ? 1 - 0.72 * fade.story : 1 - 0.5 * fade.highlight;
		v.push(...(lit || k >= 1 ? own : dimmed(own, k)));
		if ((focus ? fade.story : highlight ? fade.highlight : 0) > 0.5 && lit) v.push(...marker([a.at[0], 0, a.at[1]], t));
	}
	return [...v, ...extra];
}

export function activity(a: Agent): Activity {
	if (a.leader) return 'lead';
	if (a.state === 'nap' || a.errand === 'nap') return 'nap';
	if (a.asking !== undefined || (story?.step === 2 && a === story.crew[0])) return 'ask';
	switch (a.errand) {
		case 'visit': return 'high-five';
		case 'deliver': return 'deliver';
		case 'tea': case 'coffee': return 'drink';
		case 'memo': return 'memo';
		case 'sandbox': return 'sandbox';
		default: return a.state === 'walk' ? 'back' : 'work';
	}
}

// How many calves are doing what right now.
export function census(): Partial<Record<Activity, number>> {
	const counts: Partial<Record<Activity, number>> = {};
	for (const a of office.agents) counts[activity(a)] = (counts[activity(a)] ?? 0) + 1;
	return counts;
}

// Plays a step of the story (0 to 3), or stops it with undefined.
export function setStory(step: number | undefined) {
	if (step === undefined) { story = undefined; return; }
	if (story?.step === step) return;
	const boss = office.agents.find(a => a.leader)!;
	const nearest = (to: Agent, but: Agent[]) => office.agents
		.filter(a => !a.leader && a.state === 'work' && !but.includes(a))
		.sort((a, b) => Math.hypot(a.at[0] - to.at[0], a.at[1] - to.at[1]) - Math.hypot(b.at[0] - to.at[0], b.at[1] - to.at[1]));
	const crew = story?.crew ?? nearest(boss, []).slice(0, 2);
	const helper = story?.helper ?? nearest(crew[1], crew)[0];
	story = { step, since: office.time, crew, helper };
}

// Sets how far the spotlight (story) and the highlight have faded in.
export function setFade(story: number, highlight: number) {
	fade = { story, highlight };
}

// Marks the calves doing any of these, or none.
export function setHighlight(activities: Activity[] | undefined) {
	highlight = activities;
}

// The calf drawn at (x, y) on a canvas of that size, if any, nearest the
// front when they overlap.
export function calfAt(x: number, y: number, width: number, height: number): Activity | undefined {
	const f = officeFrame(width, height);
	let best: Agent | undefined;
	for (const a of office.agents) {
		const lying = a.state === 'nap';
		const [cx, cy] = project(a.at[0] + (lying ? 3.5 : 0.5), lying ? 3 : 6, a.at[1] + 0.5, f);
		if (Math.abs(x - cx) > (lying ? 7 : 4.5) * f.unit || Math.abs(y - cy) > (lying ? 4 : 7.5) * f.unit) continue;
		if (!best || a.at[0] + a.at[1] > best.at[0] + best.at[1]) best = a;
	}
	return best && activity(best);
}

// Small calves: a voxel is a couple of rendered pixels, and the office sits
// in the middle of the stage, under the title.
export function officeFrame(width: number, height: number) {
	const unit = Math.min(2.8, Math.max(1.6, Math.min(width / 260, height / 150)));
	return { unit, x: width / 2, y: height * 0.54 - (SIZE / Math.sqrt(6)) * unit };
}
