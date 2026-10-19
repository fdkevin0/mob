// Voxel models for the landing page: anthropomorphic calves (the agents),
// desks, blocks and small props. A voxel is [x, y, z, r, g, b, glow, size];
// size scales a cube about its own centre, so blocks can be smaller than a
// grid cell. Models are built facing +z and turned in quarter steps.

export type RGB = [number, number, number];
export type Voxel = [number, number, number, number, number, number, number, number];

export const hex = (value: string): RGB => {
	const n = parseInt(value.slice(1), 16);
	return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const colors = {
	lime: hex('#c8f560'),
	cyan: hex('#62e0ea'),
	amber: hex('#ffb648'),
	violet: hex('#a894ff'),
	white: hex('#f2f4ee'),
	ink: hex('#141518'),
	horn: hex('#f6ead0'),
	hoof: hex('#3a2f2a'),
	muzzle: hex('#ffb8ae'),
	nostril: hex('#d9786f'),
	desk: hex('#5b4a3d'),
	deskTop: hex('#7a6553'),
	floorA: hex('#1a1d21'),
	floorB: hex('#16191c'),
};

export type CalfStyle = {
	body: RGB;
	spots?: RGB;
	blaze?: RGB; // a face stripe
	belly?: RGB;
	seed: number;
	shades?: boolean; // the boss wears sunglasses
};

export const calves = {
	boss: { body: hex('#f1f0ea'), spots: hex('#17181b'), seed: 3, shades: true },
	brown: { body: hex('#a8683d'), spots: hex('#7d4a2a'), blaze: hex('#f1e6d6'), seed: 5 },
	lime: { body: colors.lime, spots: hex('#5d7f22'), seed: 8 },
	blue: { body: hex('#5ab4f0'), belly: hex('#e4f3ff'), seed: 11 },
	lilac: { body: hex('#b9a8ff'), spots: hex('#f4f0ff'), seed: 2 },
} satisfies Record<string, CalfStyle>;

export type Pose = 'idle' | 'catch' | 'hold' | 'throw' | 'type' | 'whip-up' | 'whip-crack' | 'startle' | 'lie' | 'stretch';

// Patches that look like hide markings rather than noise.
const spotted = (x: number, y: number, z: number, seed: number) =>
	Math.sin(x * 1.3 + seed) + Math.cos(y * 0.9 + z * 1.1 + seed * 1.7) + Math.sin((x + z) * 0.7 + y * 0.4 + seed * 0.3) > 1.3;

type Put = (x: number, y: number, z: number, color: RGB, glow?: number) => void;

function arm(put: Put, side: number, pose: Pose, frame: number, color: RGB) {
	const x = side * 3;
	const right = side > 0;
	let cells: [number, number, number][] = [];
	switch (pose) {
		case 'catch': case 'startle': case 'stretch':
			cells = [[x, 7, 0], [x, 8, 0], [x, 9, 0], [x, 10, 0]]; break;
		case 'hold':
			cells = [[x, 6, 0], [x, 6, 1], [x, 6, 2]]; break;
		case 'type': {
			const up = (frame + (right ? 1 : 0)) % 2;
			cells = [[x, 6, 0], [x, 6, 1], [x, 5 + up, 2]]; break;
		}
		case 'throw':
			cells = right ? [[x, 7, 0], [x, 8, 1], [x, 9, 2]] : [[x, 6, 0], [x, 5, 0], [x, 4, 0]]; break;
		case 'whip-up':
			cells = right ? [[x, 7, 0], [x, 8, 0], [x, 9, -1]] : [[x, 6, 0], [x, 5, 0], [x, 4, 0]]; break;
		case 'whip-crack':
			cells = right ? [[x, 6, 1], [x, 6, 2], [x, 6, 3]] : [[x, 6, 0], [x, 5, 0], [x, 4, 0]]; break;
		default:
			cells = [[x, 6, 0], [x, 5, 0], [x, 4, 0]];
	}
	cells.forEach(([cx, cy, cz], i) => put(cx, cy, cz, i === cells.length - 1 ? colors.hoof : color));
}

// A standing calf, about 12 voxels tall, facing +z with its feet at y = 0.
export function calf(style: CalfStyle, pose: Pose, frame = 0): Voxel[] {
	const voxels: Voxel[] = [];
	const put: Put = (x, y, z, color, glow = 0) => { voxels.push([x, y, z, ...color, glow, 1]); };
	const hide = (x: number, y: number, z: number) => {
		if (style.belly && z === 1 && y >= 3 && y <= 5 && Math.abs(x) <= 1) return style.belly;
		if (style.blaze && z === 2 && x === 0 && y >= 8) return style.blaze;
		if (style.spots && spotted(x, y, z, style.seed)) return style.spots;
		return style.body;
	};
	// Legs and hooves.
	for (const x of [-1, 1]) { put(x, 0, 0, colors.hoof); put(x, 1, 0, style.body); put(x, 2, 0, hide(x, 2, 0)); }
	// Torso.
	for (let x = -2; x <= 2; x++) for (let y = 3; y <= 6; y++) for (let z = -1; z <= 1; z++) put(x, y, z, hide(x, y, z));
	// Tail with a tuft.
	put(0, 5, -2, style.body); put(0, 4, -2, style.body); put(0, 3, -2, colors.ink);
	arm(put, -1, pose, frame, style.body);
	arm(put, 1, pose, frame, style.body);
	// Head.
	const blink = pose === 'idle' && frame % 9 === 0;
	for (let x = -2; x <= 2; x++) for (let y = 7; y <= 10; y++) for (let z = -1; z <= 2; z++) {
		const eye = z === 2 && y === 9 && Math.abs(x) === 1 && !blink;
		const shades = style.shades && z === 2 && y === 9;
		put(x, y, z, shades ? colors.ink : eye ? colors.ink : hide(x, y, z));
	}
	if (style.shades) { put(-2, 9, 1, colors.ink); put(2, 9, 1, colors.ink); }
	// Muzzle with nostrils.
	for (let x = -1; x <= 1; x++) for (const y of [7, 8]) put(x, y, 3, y === 8 && x !== 0 ? colors.nostril : colors.muzzle);
	// Ears and horns.
	const ear = pose === 'idle' && frame % 7 === 3 ? 10 : 9;
	put(-3, ear, 0, style.body); put(3, ear, 0, style.body);
	put(-2, 11, 1, colors.horn); put(2, 11, 1, colors.horn);
	if (pose === 'whip-up' || pose === 'whip-crack') whip(put, pose);
	return voxels;
}

// The boss's whip, from the right hoof.
function whip(put: Put, pose: Pose) {
	const leather = hex('#8a5a32');
	if (pose === 'whip-up') {
		for (let i = 1; i <= 5; i++) put(3, 9 + Math.min(i, 3), -1 - i, leather);
		return;
	}
	for (let i = 1; i <= 7; i++) put(3, 6 - (i > 4 ? 1 : 0), 3 + i, i === 7 ? colors.amber : leather, i === 7 ? 1 : 0);
}

// Quarter turns about y: 0 faces +z, 1 faces +x, 2 faces -z, 3 faces -x.
export function turn(voxels: Voxel[], facing: number): Voxel[] {
	const f = ((facing % 4) + 4) % 4;
	return voxels.map(v => {
		const [x, , z] = v;
		const [nx, nz] = f === 0 ? [x, z] : f === 1 ? [z, -x] : f === 2 ? [-x, -z] : [-z, x];
		return [nx, v[1], nz, v[3], v[4], v[5], v[6], v[7]];
	});
}

// Lying on its back, face up, head towards -z.
export function lying(voxels: Voxel[]): Voxel[] {
	return voxels.map(v => [v[0], v[2] + 2, -v[1], v[3], v[4], v[5], v[6], v[7]]);
}

export function move(voxels: Voxel[], dx: number, dy: number, dz: number): Voxel[] {
	return voxels.map(v => [v[0] + dx, v[1] + dy, v[2] + dz, v[3], v[4], v[5], v[6], v[7]]);
}

export function desk(): Voxel[] {
	const voxels: Voxel[] = [];
	for (let x = -2; x <= 2; x++) for (let z = 0; z <= 1; z++) {
		voxels.push([x, 4, z, ...colors.deskTop, 0, 1]);
		if (Math.abs(x) === 2) for (let y = 0; y < 4; y++) voxels.push([x, y, z, ...colors.desk, 0, 1]);
	}
	return voxels;
}

// A "Z" floating above a sleeper.
export function snore(x: number, y: number, z: number, scale = 0.5): Voxel[] {
	const voxels: Voxel[] = [];
	['###', '..#', '.#.', '#..', '###'].forEach((row, iy) => [...row].forEach((c, ix) => {
		if (c === '#') voxels.push([x + ix * scale, y - iy * scale, z, ...colors.white, 0.4, scale]);
	}));
	return voxels;
}

// An exclamation mark for a startled calf.
export function alarm(x: number, y: number, z: number): Voxel[] {
	return [0, 1, 2, 4].map(i => [x, y - i, z, ...colors.amber, 1, 0.8] as Voxel);
}
