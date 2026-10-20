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
	hoof: hex('#3a2f2a'),
	muzzle: hex('#f7d2ad'),
	muzzleShade: hex('#e4b086'),
	nostril: hex('#c8835f'),
	chin: hex('#f4dfc4'),
	brow: hex('#3b2214'),
	eye: hex('#f6efe4'),
	ear: hex('#f6b39a'),
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
	muzzle?: RGB;
};

export const calves = {
	boss: { body: hex('#f1f0ea'), spots: hex('#17181b'), seed: 3, shades: true },
	brown: { body: hex('#a8683d'), spots: hex('#7d4a2a'), blaze: hex('#f1e6d6'), seed: 5 },
	lime: { body: colors.lime, spots: hex('#5d7f22'), seed: 8 },
	blue: { body: hex('#5ab4f0'), belly: hex('#e4f3ff'), seed: 11 },
	lilac: { body: hex('#b9a8ff'), spots: hex('#f4f0ff'), seed: 2 },
} satisfies Record<string, CalfStyle>;

export type Pose = 'idle' | 'catch' | 'hold' | 'throw' | 'type' | 'whip-up' | 'whip-crack' | 'startle' | 'lie' | 'stretch' | 'walk' | 'carry' | 'drink' | 'high-five';

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
		case 'walk': {
			const swing = (frame % 2 ? 1 : -1) * side;
			cells = [[x, 6, 0], [x, 5, swing], [x, 4, swing]]; break;
		}
		case 'carry': // walking with something held out in front
			cells = [[x, 6, 0], [x, 6, 1], [x, 6, 2]]; break;
		case 'drink':
			cells = right ? [[x, 7, 0], [x, 8, 1], [x, 8, 2]] : [[x, 6, 0], [x, 5, 0], [x, 4, 0]]; break;
		case 'high-five':
			cells = right ? [[x, 7, 0], [x, 8, 0], [x, 9, 0], [x, 10, 0]] : [[x, 6, 0], [x, 5, 0], [x, 4, 0]]; break;
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
	const stride = pose === 'walk' || pose === 'carry' ? (frame % 2 ? 1 : -1) : 0;
	for (const x of [-1, 1]) {
		const step = stride * x;
		put(x, 0, step, colors.hoof); put(x, 1, step, style.body); put(x, 2, 0, hide(x, 2, 0));
	}
	// Torso.
	for (let x = -2; x <= 2; x++) for (let y = 3; y <= 6; y++) for (let z = -1; z <= 1; z++) put(x, y, z, hide(x, y, z));
	// Tail with a tuft.
	put(0, 5, -2, style.body); put(0, 4, -2, style.body); put(0, 3, -2, colors.ink);
	arm(put, -1, pose, frame, style.body);
	arm(put, 1, pose, frame, style.body);
	// Head, after the 牛来的 calf: heavy flat brows, small staring eyes, a big
	// pale muzzle and pointed ears that stick out, pink inside.
	const w = 2; // half the head's width
	const top = 11;
	const eyeX = 1;
	const blink = pose === 'idle' && frame % 9 === 0;
	for (let x = -w; x <= w; x++) for (let y = 7; y <= top; y++) for (let z = -1; z <= 2; z++) {
		const face = z === 2;
		const brow = face && y === top - 1 && Math.abs(x) >= 1 && Math.abs(x) <= eyeX + 1;
		const eye = face && y === top - 2 && Math.abs(x) === eyeX && !blink;
		const shades = style.shades && face && y === top - 2;
		put(x, y, z, shades ? colors.ink : brow ? colors.brow : eye ? colors.eye : hide(x, y, z));
	}
	if (!style.shades && !blink) for (const s of [-1, 1]) voxels.push([s * eyeX, top - 2.15, 2.3, ...colors.ink, 0, 0.5]);
	if (style.shades) { put(-w, top - 2, 1, colors.ink); put(w, top - 2, 1, colors.ink); }
	// The muzzle sticks out across the whole face, nostrils at its top corners,
	// with a pale chin underneath.
	const muzzle = style.muzzle ?? colors.muzzle;
	const rows = [7, 8];
	for (let x = -w; x <= w; x++) for (const y of rows) {
		put(x, y, 3, y === rows[rows.length - 1] && Math.abs(x) === w - 1 ? colors.nostril : Math.abs(x) === w ? colors.muzzleShade : muzzle);
	}
	for (let x = -1; x <= 1; x++) put(x, 6, 2, colors.chin);
	put(0, 6, 3, colors.chin);
	// Ears.
	const ear = top - 1 - (pose === 'idle' && frame % 7 === 3 ? 1 : 0);
	for (const s of [-1, 1]) {
		put(s * (w + 1), ear, 0, colors.ear); put(s * (w + 1), ear, -1, style.body);
		put(s * (w + 2), ear + 1, 0, style.body);
	}
	if (pose === 'whip-up' || pose === 'whip-crack') whip(put, pose);
	return voxels;
}

// The boss's whip, from the right hoof.
function whip(put: Put, pose: Pose) {
	const cord = hex('#f0b45c');
	if (pose === 'whip-up') {
		for (let i = 1; i <= 6; i++) put(3, 9 + Math.min(i, 4), -1 - i, cord, 0.4);
		return;
	}
	// The crack: a long bright cord ending in a burst of sparks.
	for (let i = 1; i <= 8; i++) put(3, 6 - (i > 4 ? 1 : 0) - (i > 6 ? 1 : 0), 3 + i, cord, 0.4);
	voxelsFlash(put, 3, 4, 12);
}

function voxelsFlash(put: Put, x: number, y: number, z: number) {
	put(x, y, z, colors.white, 1);
	for (const [dx, dy, dz] of [[0, 1.5, 0], [0, -1.5, 0], [1.5, 0, 0], [-1.5, 0, 0], [0, 0, 1.5], [1, 1, 1], [-1, 1, -1]]) put(x + dx, y + dy, z + dz, colors.amber, 1);
}

// One calf template, many hides: a seeded skin with a coat colour and a
// marking (patches, a face blaze or a pale belly). Gold and sunglasses are
// kept for the leader.
const coats = ['#f1f0ea', '#2b2826', '#d08a4e', '#a8683d', '#8d929a', '#d9c39b', '#5ab4f0', '#b9a8ff', '#9bd86a', '#f2a7b8', '#6b4a35'].map(hex);
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const light = (c: RGB) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11 > 0.55;

export const leader: CalfStyle = { body: hex('#f2c33a'), belly: hex('#ffe08a'), seed: 1, shades: true, muzzle: hex('#f6c9a6') };

export function skin(seed: number): CalfStyle {
	let a = (seed * 2654435761) >>> 0;
	const next = () => { a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return (a >>> 0) / 4294967296; };
	const body = coats[Math.floor(next() * coats.length)];
	const mark = light(body) ? (next() < 0.5 ? hex('#2b2826') : shade(body, 0.62)) : (next() < 0.6 ? hex('#f1ece2') : shade(body, 1.35).map(v => Math.min(1, v)) as RGB);
	const kind = next();
	return {
		body,
		spots: kind < 0.45 ? mark : undefined,
		blaze: kind >= 0.45 && kind < 0.65 ? hex('#f1ece2') : undefined,
		belly: kind >= 0.65 && kind < 0.85 ? (light(body) ? shade(body, 0.8) : hex('#f1ece2')) : undefined,
		seed: Math.floor(next() * 20),
	};
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

// A cup of milk tea with a straw, standing on its base at (x, y, z).
export function tea(x: number, y: number, z: number): Voxel[] {
	return [
		[x, y, z, ...hex('#e8dccb'), 0, 0.9],
		[x, y + 0.9, z, ...hex('#c99e72'), 0, 0.9],
		[x + 0.2, y + 1.7, z + 0.2, ...hex('#ff8fa3'), 0.3, 0.5],
	];
}

// An exclamation mark for a startled calf.
export function alarm(x: number, y: number, z: number): Voxel[] {
	return [0, 1, 2, 4].map(i => [x, y - i, z, ...colors.amber, 1, 0.8] as Voxel);
}
