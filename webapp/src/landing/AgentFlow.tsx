import { useEffect, useRef } from 'react';
import { icons, type IconName } from './pixels';

// An idealised agent loop drawn on a pixel grid: a request comes in, the agent
// plans, fans out to tools, asks for approval, delivers and remembers. Every
// frame is a pure function of the time in the loop, so nothing accumulates.

const COLS = 96;
const ROWS = 54;
const SPEED = 30; // cells per second

type Point = [number, number];
type Box = { label: string; x: number; y: number; w: number; h: number; icon?: IconName };

const nodes = {
	input: { label: 'YOU', x: 3, y: 21, w: 13, h: 13, icon: 'message' },
	plan: { label: 'PLAN', x: 24, y: 2, w: 25, h: 10 },
	core: { label: 'AGENT', x: 28, y: 19, w: 17, h: 17 },
	search: { label: 'SEARCH', x: 56, y: 2, w: 11, h: 10, icon: 'search' },
	browser: { label: 'BROWSER', x: 56, y: 14, w: 11, h: 10, icon: 'browser' },
	code: { label: 'CODE', x: 56, y: 31, w: 11, h: 10, icon: 'code' },
	files: { label: 'FILES', x: 56, y: 43, w: 11, h: 10, icon: 'files' },
	approve: { label: 'APPROVE', x: 70, y: 22, w: 9, h: 11, icon: 'shield' },
	output: { label: 'DONE', x: 84, y: 21, w: 11, h: 13, icon: 'send' },
	memory: { label: 'MEMORY', x: 28, y: 44, w: 17, h: 8 },
} satisfies Record<string, Box>;

const tools = ['search', 'browser', 'code', 'files'] as const;
const toolY = { search: 7, browser: 19, code: 36, files: 48 };

export const colors = {
	lime: '#c8f560',
	cyan: '#62e0ea',
	amber: '#ffb648',
	white: '#f4f6ef',
};

// Cells along orthogonal waypoints, both ends included.
function path(...points: Point[]): Point[] {
	const cells: Point[] = [points[0]];
	for (let i = 1; i < points.length; i++) {
		let [x, y] = points[i - 1];
		const [tx, ty] = points[i];
		while (x !== tx || y !== ty) {
			x += Math.sign(tx - x); y += Math.sign(ty - y);
			cells.push([x, y]);
		}
	}
	return cells;
}

const paths = {
	input: path([16, 27], [27, 27]),
	plan: path([36, 18], [36, 12]),
	approve: path([45, 27], [69, 27]),
	output: path([79, 27], [83, 27]),
	memory: path([36, 36], [36, 43]),
	...Object.fromEntries(tools.map(tool => [tool, path([45, 27], [50, 27], [50, toolY[tool]], [55, toolY[tool]])])) as Record<typeof tools[number], Point[]>,
};

type Packet = { cells: Point[]; start: number; color: string };
const travel = (cells: Point[]) => (cells.length / SPEED) * 1000;

// The timeline, in milliseconds from the start of the loop.
function timeline() {
	const packets: Packet[] = [];
	const send = (cells: Point[], start: number, color: string) => { packets.push({ cells, start, color }); return start + travel(cells); };
	const heard = send(paths.input, 250, colors.white);
	const planned = send(paths.plan, heard + 250, colors.lime);
	const work = tools.map((tool, i) => {
		const sent = planned + 650 + i * 380;
		const arrived = send(paths[tool], sent, colors.cyan);
		const replied = arrived + 650 + (i % 2) * 250;
		const returned = send([...paths[tool]].reverse(), replied, colors.lime);
		return { tool, sent, arrived, replied, returned };
	});
	const gathered = Math.max(...work.map(w => w.returned));
	const asked = send(paths.approve, gathered + 300, colors.amber);
	const approved = asked + 1100;
	const delivered = send(paths.output, approved + 150, colors.lime);
	const remembered = send(paths.memory, delivered + 450, colors.lime);
	const end = remembered + 2600;
	const phases = [0, heard, planned + 500, gathered, approved, delivered + 300, end];
	return { packets, heard, planned, work, gathered, asked, approved, delivered, remembered, end, phases };
}

const plan = timeline();
export const loopLength = plan.end;

export const steps = [
	{ title: 'Listen', text: 'A request arrives from any channel.' },
	{ title: 'Plan', text: 'The goal becomes a short list of steps.' },
	{ title: 'Act', text: 'Tools run in parallel, in a sandbox.' },
	{ title: 'Approve', text: 'Anything with an effect waits for you.' },
	{ title: 'Deliver', text: 'The answer comes back where you are.' },
	{ title: 'Remember', text: 'What matters is kept for next time.' },
];

export function phaseAt(t: number) {
	let phase = 0;
	for (let i = 0; i < steps.length; i++) if (t >= plan.phases[i]) phase = i;
	return phase;
}

const hash = (x: number, y: number) => {
	const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
	return n - Math.floor(n);
};
const ease = (v: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, v)), 3);
const within = (t: number, from: number, to: number) => t >= from && t < to;

type Draw = {
	ctx: CanvasRenderingContext2D;
	size: number;
	cell: (x: number, y: number, color: string, alpha: number, scale?: number) => void;
};

function render(d: Draw, t: number, showLabels: boolean) {
	const { ctx, size, cell } = d;
	ctx.clearRect(0, 0, COLS * size, ROWS * size);
	const fade = t > plan.end - 700 ? Math.max(0, (plan.end - t) / 700) : 1;

	// Ripples from the moments that matter.
	const ripples = [
		{ x: 9, y: 27, at: 0, color: colors.white },
		{ x: 74, y: 27, at: plan.approved, color: colors.amber },
		{ x: 89, y: 27, at: plan.delivered, color: colors.lime },
	].filter(r => t >= r.at && t < r.at + 1800);

	// The grid of dots, with a faint shimmer.
	for (let y = 0; y < ROWS; y++) {
		for (let x = 0; x < COLS; x++) {
			const h = hash(x, y);
			const shimmer = Math.pow(Math.max(0, Math.sin(t / 900 * (0.4 + h) + h * 40)), 24);
			cell(x, y, colors.white, 0.07 + shimmer * 0.22, 0.2 + shimmer * 0.3);
			for (const r of ripples) {
				const age = (t - r.at) / 1800;
				const radius = age * 46;
				const band = 1 - Math.abs(Math.hypot(x - r.x, (y - r.y) * 1.1) - radius) / 1.6;
				if (band > 0) cell(x, y, r.color, band * 0.35 * (1 - age), 0.7);
			}
		}
	}

	// Wires.
	for (const cells of Object.values(paths)) for (const [x, y] of cells) cell(x, y, colors.white, 0.11, 0.62);

	const box = (node: Box, color: string, strength: number) => {
		ctx.fillStyle = '#0b0d0f';
		ctx.fillRect(node.x * size, node.y * size, node.w * size, node.h * size);
		for (let x = node.x; x < node.x + node.w; x++) {
			for (let y = node.y; y < node.y + node.h; y++) {
				const edge = x === node.x || y === node.y || x === node.x + node.w - 1 || y === node.y + node.h - 1;
				const corner = (x === node.x || x === node.x + node.w - 1) && (y === node.y || y === node.y + node.h - 1);
				if (corner) continue;
				if (edge) cell(x, y, color, 0.18 + strength * 0.75, 0.86);
				else cell(x, y, colors.white, 0.025, 0.2);
			}
		}
		if (node.icon) {
			const icon = icons[node.icon];
			const ox = node.x + Math.floor((node.w - icon[0].length) / 2);
			const oy = node.y + Math.floor((node.h - icon.length) / 2);
			icon.forEach((row, iy) => [...row].forEach((c, ix) => { if (c === '#') cell(ox + ix, oy + iy, color, 0.28 + strength * 0.72, 0.86); }));
		}
		if (showLabels) {
			ctx.font = `${Math.max(8, Math.round(size * 0.9))}px Silkscreen, 'Geist Mono', monospace`;
			ctx.textBaseline = 'bottom';
			const width = ctx.measureText(node.label).width;
			ctx.fillStyle = '#07080a';
			ctx.fillRect(node.x * size - 2, (node.y - 1) * size, width + 4, size);
			ctx.fillStyle = color;
			ctx.globalAlpha = 0.4 + strength * 0.6;
			ctx.fillText(node.label, node.x * size, node.y * size - size * 0.15);
			ctx.globalAlpha = 1;
		}
	};
	const pulse = (speed = 260) => 0.65 + 0.35 * Math.sin(t / speed);

	// Request.
	box(nodes.input, colors.white, t < plan.heard ? pulse(140) : 0.45);

	// Plan board: one bar per tool call, filling as results come back.
	const planOn = t >= plan.heard + 300;
	box(nodes.plan, colors.lime, planOn ? (t < plan.gathered ? 0.85 : 0.5) : 0);
	plan.work.forEach((w, i) => {
		const shown = ease((t - plan.planned - i * 120) / 300);
		if (shown <= 0) return;
		const y = nodes.plan.y + 2 + i * 2;
		const width = nodes.plan.w - 6;
		const sent = ease((t - w.sent) / 400) * 0.35;
		const done = ease((t - w.returned) / 450) * 0.65;
		const filled = Math.round(width * (sent + done));
		for (let x = 0; x < width * shown; x++) {
			const lit = x < filled;
			cell(nodes.plan.x + 3 + x, y, lit ? (t >= w.returned ? colors.lime : colors.cyan) : colors.white, lit ? 0.85 : 0.14, 0.86);
		}
		cell(nodes.plan.x + 1, y, t >= w.returned ? colors.lime : colors.white, t >= w.returned ? 0.9 : 0.25, 0.5);
	});

	// Tools.
	for (const w of plan.work) {
		const working = within(t, w.arrived, w.replied);
		const done = t >= w.returned && t < plan.end;
		box(nodes[w.tool], working ? colors.cyan : done ? colors.lime : colors.white, working ? pulse(90) : done ? 0.4 : 0);
		if (working) {
			const node = nodes[w.tool];
			for (let i = 0; i < 3; i++) {
				const x = node.x + 1 + Math.floor(hash(i, Math.floor(t / 90)) * (node.w - 2));
				const y = node.y + 1 + Math.floor(hash(Math.floor(t / 90), i + 7) * (node.h - 2));
				cell(x, y, colors.cyan, 0.5, 0.5);
			}
		}
	}

	// Approval gate: blinks amber while it waits, turns green when allowed.
	const waiting = within(t, plan.asked, plan.approved);
	const allowed = t >= plan.approved;
	box(nodes.approve, waiting ? colors.amber : allowed ? colors.lime : colors.white,
		waiting ? (Math.floor((t - plan.asked) / 180) % 2 ? 1 : 0.25) : allowed ? 0.75 : 0);

	box(nodes.output, t >= plan.delivered ? colors.lime : colors.white, t >= plan.delivered ? (t < plan.delivered + 900 ? pulse(90) : 0.85) : 0);

	// Memory: rows of kept facts, one more each loop.
	box(nodes.memory, t >= plan.remembered ? colors.lime : colors.white, t >= plan.remembered ? 0.6 : 0.1);
	[13, 8].forEach((length, row) => {
		for (let x = 0; x < length; x++) cell(nodes.memory.x + 2 + x, nodes.memory.y + 2 + row, colors.white, 0.2, 0.86);
	});
	const fresh = Math.round(ease((t - plan.remembered) / 700) * 10);
	for (let x = 0; x < fresh; x++) cell(nodes.memory.x + 2 + x, nodes.memory.y + 5, colors.lime, 0.9, 0.86);

	// The agent core: a comet orbiting its centre, faster while it thinks.
	const thinking = t >= plan.heard && t < plan.remembered + 600;
	box(nodes.core, colors.lime, thinking ? 0.75 + 0.25 * Math.sin(t / 200) : 0.35);
	const cx = nodes.core.x + 8, cy = nodes.core.y + 8;
	const angle = t / (thinking ? 260 : 900);
	for (let y = -6; y <= 6; y++) {
		for (let x = -6; x <= 6; x++) {
			const r = Math.hypot(x, y);
			if (r > 4.6 && r < 6.2) {
				let diff = (Math.atan2(y, x) - angle) % (Math.PI * 2);
				if (diff < 0) diff += Math.PI * 2;
				const tail = Math.max(0, 1 - diff / 2.6);
				cell(cx + x, cy + y, colors.lime, 0.1 + tail * 0.9, 0.86);
			} else if (r <= 2.3) {
				const flicker = thinking ? hash(x + 9, y + Math.floor(t / 110)) : 0.4;
				cell(cx + x, cy + y, flicker > 0.45 ? colors.lime : colors.white, 0.35 + flicker * 0.6, 0.86);
			}
		}
	}

	// Packets with fading tails.
	for (const p of plan.packets) {
		const head = Math.floor(((t - p.start) / 1000) * SPEED);
		if (head < 0 || head > p.cells.length + 7) continue;
		ctx.shadowColor = p.color;
		ctx.shadowBlur = size * 1.2;
		for (let k = 0; k < 8; k++) {
			const i = head - k;
			if (i < 0 || i >= p.cells.length) continue;
			const [x, y] = p.cells[i];
			cell(x, y, k === 0 ? colors.white : p.color, (1 - k / 8) * 0.95, k === 0 ? 1 : 0.86);
		}
		ctx.shadowBlur = 0;
	}

	if (fade < 1) {
		ctx.fillStyle = `rgba(7, 8, 10, ${1 - fade})`;
		ctx.fillRect(0, 0, COLS * size, ROWS * size);
	}
}

export function AgentFlow({ onPhase }: { onPhase?: (phase: number, t: number) => void }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const element = canvas.current;
		const ctx = element?.getContext('2d');
		if (!element || !ctx) return;
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		let size = 10, frame = 0, visible = true, lastPhase = -1;
		const started = performance.now();
		const cell: Draw['cell'] = (x, y, color, alpha, scale = 0.86) => {
			if (alpha <= 0.01) return;
			const s = size * scale;
			ctx.globalAlpha = Math.min(1, alpha);
			ctx.fillStyle = color;
			ctx.fillRect(x * size + (size - s) / 2, y * size + (size - s) / 2, s, s);
			ctx.globalAlpha = 1;
		};
		const resize = () => {
			const width = element.clientWidth;
			const ratio = window.devicePixelRatio || 1;
			size = width / COLS;
			element.width = Math.round(width * ratio);
			element.height = Math.round(size * ROWS * ratio);
			ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		};
		const draw = (now: number) => {
			const t = still ? plan.delivered + 1200 : (now - started) % plan.end;
			render({ ctx, size, cell }, t, size >= 7);
			const phase = phaseAt(t);
			if (phase !== lastPhase) { lastPhase = phase; onPhase?.(phase, t); }
		};
		const loop = (now: number) => { draw(now); if (!still && visible) frame = requestAnimationFrame(loop); };
		resize();
		const observer = new ResizeObserver(() => { resize(); draw(performance.now()); });
		observer.observe(element);
		const seen = new IntersectionObserver(([entry]) => {
			const was = visible; visible = entry.isIntersecting;
			if (visible && !was && !still) frame = requestAnimationFrame(loop);
		});
		seen.observe(element);
		document.fonts?.ready.then(() => draw(performance.now()));
		frame = requestAnimationFrame(loop);
		return () => { cancelAnimationFrame(frame); observer.disconnect(); seen.disconnect(); };
	}, [onPhase]);
	return <canvas ref={canvas} className="flow-canvas" role="img" aria-label="Animation of an agent at work: it hears a request, plans, uses four tools, waits for approval, delivers the answer and remembers it." />;
}
