// The hero scene: agents passing data to each other in 3D, seen along the
// normal of the plane x + y + z = 0 (a true isometric view, y up). Both the
// WebGPU renderer and the 2D fallback draw from these arrays.

export type Vec3 = [number, number, number];
type Color = [number, number, number];

export const palette = {
	lime: [0.78, 0.96, 0.38] as Color,
	cyan: [0.38, 0.88, 0.92] as Color,
	amber: [1, 0.71, 0.28] as Color,
	white: [0.93, 0.95, 0.9] as Color,
	violet: [0.66, 0.58, 1] as Color,
};

// Screen axes for the camera at (1, 1, 1) looking at the origin.
export const right: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
export const up: Vec3 = [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

type Node = { at: Vec3; size: number; color: Color; phase: number };

const nodes: Record<string, Node> = {
	you: { at: [-4, 4.5, -4], size: 0.7, color: palette.white, phase: 0 },
	core: { at: [0, 2.5, 0], size: 1.4, color: palette.lime, phase: 1 },
	memory: { at: [0, 0, 0], size: 0.9, color: palette.violet, phase: 2 },
};
const directions: [Vec3, Vec3][] = [[[1, 0, 0], [0, 0, 1]], [[0, 0, 1], [-1, 0, 0]], [[-1, 0, 0], [0, 0, -1]], [[0, 0, -1], [1, 0, 0]]];
const agents = directions.map(([dir, perp], i) => {
	const name = `agent${i}`;
	nodes[name] = { at: [dir[0] * 6 - perp[0], 1, dir[2] * 6 - perp[2]], size: 0.8, color: palette.cyan, phase: 3 + i };
	const tools = [1, -1].map((side, k) => {
		const tool = `${name}.tool${k}`;
		const a = nodes[name].at;
		nodes[tool] = { at: [a[0] + dir[0] * 2.5 + perp[0] * 2 * side, 0, a[2] + dir[2] * 2.5 + perp[2] * 2 * side], size: 0.45, color: palette.amber, phase: 7 + i * 2 + k };
		return tool;
	});
	return { name, tools };
});

type Edge = { from: string; to: string; color: Color; packets: number; speed: number; both?: boolean; zFirst?: boolean };
const edges: Edge[] = [
	{ from: 'you', to: 'core', color: palette.white, packets: 3, speed: 3.2, both: true },
	{ from: 'core', to: 'memory', color: palette.violet, packets: 2, speed: 1.6, both: true },
	...agents.flatMap(({ name, tools }, i): Edge[] => [
		{ from: 'core', to: name, color: palette.lime, packets: 4, speed: 2.6 + i * 0.2, both: true, zFirst: i % 2 === 1 },
		...tools.map((tool, k): Edge => ({ from: name, to: tool, color: palette.amber, packets: 2, speed: 2, both: true, zFirst: k === 1 })),
		{ from: name, to: agents[(i + 1) % agents.length].name, color: palette.cyan, packets: 2, speed: 1.8, zFirst: i % 2 === 0 },
	]),
];

// An axis-aligned route between two points, as four points with the
// distance travelled so far in the fourth component.
function route(a: Vec3, b: Vec3, zFirst = false): number[] {
	const mid1: Vec3 = zFirst ? [a[0], a[1], b[2]] : [b[0], a[1], a[2]];
	const points: Vec3[] = [a, mid1, [b[0], a[1], b[2]], b];
	let distance = 0;
	return points.flatMap((p, i) => {
		if (i > 0) distance += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1], p[2] - points[i - 1][2]);
		return [...p, distance];
	});
}

export type Scene = {
	lines: Float32Array; // position, colour (rgba), pulse phase (-1 = steady)
	faces: Float32Array;
	paths: Float32Array; // 4 × vec4 per path
	particles: Float32Array; // path, phase, speed, size, colour (rgba)
};

export function buildScene(): Scene {
	const lines: number[] = [];
	const faces: number[] = [];
	const paths: number[] = [];
	const particles: number[] = [];
	const line = (a: Vec3, b: Vec3, color: Color, alpha: number, phase = -1) => lines.push(...a, ...color, alpha, phase, ...b, ...color, alpha, phase);

	// Ground grid, brighter every fifth line.
	for (let i = -11; i <= 11; i++) {
		const alpha = i % 5 === 0 ? 0.09 : 0.04;
		line([i, 0, -11], [i, 0, 11], palette.white, alpha);
		line([-11, 0, i], [11, 0, i], palette.white, alpha);
	}

	for (const node of Object.values(nodes)) {
		const [x, y, z] = node.at;
		const h = node.size / 2;
		const corner = (i: number): Vec3 => [x + (i & 1 ? h : -h), y + (i & 2 ? h : -h), z + (i & 4 ? h : -h)];
		for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) line(corner(i), corner(i | bit), node.color, 0.85, node.phase);
		const quads = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
		for (const [a, b, c, d] of quads) for (const i of [a, b, c, a, c, d]) faces.push(...corner(i), ...node.color, 0.07, node.phase);
		// A drop line and a footprint tie each node to the ground.
		if (y > 0) {
			line([x, 0, z], [x, y - h, z], node.color, 0.12);
			const s = h * 1.2;
			line([x - s, 0, z - s], [x + s, 0, z - s], node.color, 0.18);
			line([x + s, 0, z - s], [x + s, 0, z + s], node.color, 0.18);
			line([x + s, 0, z + s], [x - s, 0, z + s], node.color, 0.18);
			line([x - s, 0, z + s], [x - s, 0, z - s], node.color, 0.18);
		}
	}

	let seed = 7;
	const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
	const addPath = (a: Vec3, b: Vec3, edge: Edge) => {
		const points = route(a, b, edge.zFirst);
		const index = paths.length / 16;
		paths.push(...points);
		for (let k = 0; k < 3; k++) line(points.slice(k * 4, k * 4 + 3) as Vec3, points.slice(k * 4 + 4, k * 4 + 7) as Vec3, edge.color, 0.14);
		const total = points[15];
		for (let p = 0; p < edge.packets; p++) {
			const phase = random();
			const speed = edge.speed * (0.85 + random() * 0.3);
			// Each packet is a short comet: a bright head and a fading tail.
			for (let t = 0; t < 7; t++) {
				particles.push(index, phase - (t * 0.16) / total, speed, (t === 0 ? 8 : 6.2 - t * 0.7), ...edge.color, t === 0 ? 1 : 0.7 - t * 0.09);
			}
		}
	};
	for (const edge of edges) {
		const a = nodes[edge.from].at, b = nodes[edge.to].at;
		addPath(a, b, edge);
		if (edge.both) addPath(b, a, { ...edge, zFirst: !edge.zFirst });
	}
	return { lines: new Float32Array(lines), faces: new Float32Array(faces), paths: new Float32Array(paths), particles: new Float32Array(particles) };
}

// Where the scene sits on a canvas of this size, in CSS pixels per unit.
export function framing(width: number, height: number) {
	// Narrow screens crop the outer tools rather than shrink the whole scene.
	const unit = Math.min(width / (width < 700 ? 12 : 16), height / 11.5);
	// Centre the scene's bounds, nudged down so the title has room above the core.
	return { unit, x: width / 2, y: height * 0.52 - unit * 1.2 };
}

export function project(p: Vec3, frame: ReturnType<typeof framing>): [number, number] {
	return [frame.x + dot(p, right) * frame.unit, frame.y - dot(p, up) * frame.unit];
}

// Mirrors the particle vertex shader for the 2D fallback.
export function particleAt(scene: Scene, i: number, time: number): { at: Vec3; fade: number } {
	const o = i * 8;
	const base = scene.particles[o] * 16;
	const total = scene.paths[base + 15];
	const raw = scene.particles[o + 1] + (time * scene.particles[o + 2]) / total;
	const t = raw - Math.floor(raw);
	const d = t * total;
	let at: Vec3 = [scene.paths[base], scene.paths[base + 1], scene.paths[base + 2]];
	for (let k = 1; k < 4; k++) {
		const p = base + (k - 1) * 4, c = base + k * 4;
		if (d >= scene.paths[p + 3] && d <= scene.paths[c + 3]) {
			const f = (d - scene.paths[p + 3]) / Math.max(scene.paths[c + 3] - scene.paths[p + 3], 1e-4);
			at = [0, 1, 2].map(j => scene.paths[p + j] + (scene.paths[c + j] - scene.paths[p + j]) * f) as Vec3;
		}
	}
	const smooth = (e0: number, e1: number, x: number) => { const v = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return v * v * (3 - 2 * v); };
	return { at, fade: smooth(0, 0.06, t) * (1 - smooth(0.94, 1, t)) };
}
