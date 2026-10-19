import { calf, calves, colors, move, turn, type Pose, type RGB, type Voxel } from './voxel/model';
import { add, arc, block, type Facing, type Vec } from './voxel/story';
import { VoxelCanvas } from './voxel/VoxelCanvas';

// One small voxel scene per feature, in the same world as the hero.

const tile = (x: number, z: number) => ((Math.floor(x / 2) + Math.floor(z / 2)) % 2 === 0 ? colors.floorA : colors.floorB);

function floor(half = 6): Voxel[] {
	const v: Voxel[] = [];
	for (let x = -half; x < half; x++) for (let z = -half; z < half; z++) v.push([x, -1, z, ...tile(x, z), 0, 1]);
	return v;
}

const steps = (t: number, rate: number) => Math.floor(t * rate);
const cow = (style: (typeof calves)[keyof typeof calves], pose: Pose, facing: Facing, at: Vec, t: number, hop = 0) =>
	move(turn(calf(style, pose, steps(t, 6)), facing), at[0], at[1] + hop, at[2]);
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: RGB, glow = 0): Voxel[] => {
	const v: Voxel[] = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) v.push([x, y, z, ...color, glow, 1]);
	return v;
};
const sign = (rows: string[], at: Vec, color: RGB, scale = 0.6): Voxel[] =>
	rows.flatMap((row, iy) => [...row].flatMap((c, ix) => c === '#' ? [[at[0] + ix * scale, at[1] - iy * scale, at[2], ...color, 1, scale] as Voxel] : []));

const base = floor();
const wall = colors.desk;

// Runs at home: a calf at its own desk, in its own room.
function home(t: number): Voxel[] {
	const room = [...box(-6, -6, 0, 6, -6, 5, wall), ...box(-5, 5, 0, 6, -6, -6, wall), ...box(-6, -6, 3, 4, -1, 1, colors.cyan, 0.3)];
	const deskTop = box(2, 3, 4, 4, -2, 2, colors.deskTop);
	const legs = [...box(2, 3, 0, 3, -2, -2, colors.desk), ...box(2, 3, 0, 3, 2, 2, colors.desk)];
	const lit = steps(t, 4);
	const screen = box(4, 4, 5, 8, -1, 1, colors.ink).map((v, i) => ((i + lit) % 3 === 0 ? [...v.slice(0, 3), ...colors.lime, 0.9, 1] as Voxel : v));
	return [...base, ...room, ...deskTop, ...legs, ...screen, ...cow(calves.lime, 'type', 1, [-1, 0, 0], t)];
}

// Every channel: four sources lob blocks at one calf.
function channels(t: number): Voxel[] {
	const sources: [Vec, RGB][] = [[[-5, 0, -5], colors.cyan], [[5, 0, -5], colors.amber], [[-5, 0, 3], colors.white], [[3, 0, -5], colors.violet]];
	const out = [...base];
	const hands: Vec = [0, 11.6, 0.5];
	sources.forEach(([at, color], i) => {
		out.push(...box(at[0], at[0] + 1, 0, 2, at[2], at[2] + 1, color, 0.2));
		const p = ((t + i * 0.55) % 2.2) / 1.4;
		if (p < 1) out.push(block(arc(add(at, [0.5, 3.5, 0.5]), hands, p, 4), color, 1.2, 0.8));
	});
	return [...out, ...cow(calves.blue, steps(t, 3) % 2 ? 'catch' : 'hold', 0, [0, 0, 0], t)];
}

// Asks first: holds the block, asks, gets the nod, throws.
function approval(t: number): Voxel[] {
	const p = t % 4;
	const out = [...base, ...box(4, 5, 0, 1, -1, 0, colors.desk), ...box(4, 5, 2, 2, -1, 0, p > 2.4 ? colors.lime : colors.deskTop)];
	const at: Vec = [-3, 0, 0];
	if (p < 1.8) {
		out.push(...cow(calves.brown, 'hold', 1, at, t), block([at[0] + 3.6, 6.4, 0.5], colors.lime));
		if (steps(t, 3) % 2) out.push(...sign(['###', '..#', '.##', '...', '.#.'], [at[0] - 1, 15, 1], colors.amber, 0.5));
	} else if (p < 2.4) {
		out.push(...cow(calves.brown, 'hold', 1, at, t), block([at[0] + 3.6, 6.4, 0.5], colors.lime));
		out.push(...sign(['....#', '...#.', '#.#..', '.#...'], [at[0] - 1.4, 15, 1], colors.lime, 0.5));
	} else {
		out.push(...cow(calves.brown, p < 2.7 ? 'throw' : 'idle', 1, at, t));
		if (p < 3.4) out.push(block(arc([at[0] + 3.6, 6.4, 0.5], [4.5, 3.6, -0.5], (p - 2.4) / 1, 3), colors.lime, 1.6, 0.9));
	}
	return out;
}

// Sandboxed: a calf in a pen, juggling.
function sandbox(t: number): Voxel[] {
	const fence: Voxel[] = [];
	for (let i = -5; i <= 5; i++) for (const [x, z] of [[i, -5], [i, 5], [-5, i], [5, i]] as [number, number][]) {
		const post = (i + 5) % 2 === 0;
		fence.push([x, 0, z, ...colors.desk, 0, 1], [x, 2, z, ...colors.desk, 0, 1]);
		if (post) fence.push([x, 1, z, ...colors.desk, 0, 1], [x, 3, z, ...colors.deskTop, 0, 1]);
	}
	const p = (t % 1.2) / 1.2;
	const y = 11.6 + Math.round(Math.sin(p * Math.PI) * 6) / 2;
	return [...base, ...fence, ...cow(calves.lilac, p < 0.25 || p > 0.75 ? 'catch' : 'idle', 0, [0, 0, 0], t), block([0, y, 0.5], colors.amber, 1.4, 0.9)];
}

// Remembers: a calf builds a memory tower, a layer at a time.
function memory(t: number): Voxel[] {
	const layers = Math.floor(t % 7);
	const tower: Voxel[] = [];
	for (let y = 0; y < Math.min(layers, 6); y++) tower.push(...box(2, 3, y, y, -2, -1, colors.violet, y === layers - 1 ? 0.8 : 0.1));
	const p = t % 1;
	const out = [...base, ...tower, ...cow(calves.boss, p < 0.3 ? 'throw' : 'idle', 1, [-4, 0, 0], t)];
	if (layers < 6 && p > 0.2) out.push(block(arc([-0.4, 9, 0.5], [3, layers + 1.5, -1], (p - 0.2) / 0.8, 3), colors.violet, 1.4, 0.9));
	return out;
}

// Plugs in: blocks slot into a board of sockets.
function plugins(t: number): Voxel[] {
	const board = box(-6, -6, 0, 9, -4, 3, wall);
	const slots: Vec[] = [[-5, 7, -2.5], [-5, 7, 1.5], [-5, 3, -2.5], [-5, 3, 1.5]];
	const done = Math.floor((t % 6) / 1.2);
	const out = [...base, ...board];
	slots.forEach((s, i) => out.push(block(s, i < done ? [colors.cyan, colors.lime, colors.amber, colors.violet][i] : colors.ink, 2, i < done ? 0.8 : 0)));
	const p = (t % 1.2) / 1.2;
	if (done < 4) out.push(block(arc([1.4, 9, 0.5], slots[done], p, 2), [colors.cyan, colors.lime, colors.amber, colors.violet][done], 1.6, 0.9));
	return [...out, ...cow(calves.blue, p < 0.25 ? 'throw' : 'idle', 3, [3, 0, 0], t)];
}

const frame = (width: number, height: number) => {
	const unit = Math.min(width / 19, height / 17);
	return { unit, x: width / 2, y: height * 0.76 };
};

const features = [
	{ title: 'Runs at home', hint: 'Your machine, your keys.', scene: home },
	{ title: 'Every channel', hint: 'Web, terminal, Telegram, email.', scene: channels },
	{ title: 'Asks first', hint: 'Effects wait for your nod.', scene: approval },
	{ title: 'Sandboxed', hint: 'Tools stay in the pen.', scene: sandbox },
	{ title: 'Remembers', hint: 'Keeps what matters.', scene: memory },
	{ title: 'Plugs in', hint: 'MCP servers and skills.', scene: plugins },
];

export function Features() {
	return (
		<div className="feature-grid">
			{features.map(feature => (
				<article key={feature.title} className="feature">
					<VoxelCanvas className="feature-scene" scene={feature.scene} frame={frame} pixel={3} still={1.5} />
					<h3>{feature.title}</h3>
					<p>{feature.hint}</p>
				</article>
			))}
		</div>
	);
}
