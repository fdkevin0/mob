import type { Voxel } from './model';

// A true isometric view: the camera looks along -(1, 1, 1), the normal of the
// plane x + y + z = 0, with y up. Visible faces are +x, +y and +z.

export type Frame = { unit: number; x: number; y: number };

export const shade = { top: 1, left: 0.8, right: 0.6 }; // +y, +z, +x

export function project(x: number, y: number, z: number, f: Frame): [number, number] {
	return [f.x + ((x - z) * Math.SQRT1_2) * f.unit, f.y - ((2 * y - x - z) / Math.sqrt(6)) * f.unit];
}

// Faces hidden by a neighbouring full-size voxel are skipped.
export function visibleFaces(voxels: Voxel[]) {
	const full = new Set<string>();
	for (const v of voxels) if (v[7] === 1 && Number.isInteger(v[0]) && Number.isInteger(v[1]) && Number.isInteger(v[2])) full.add(`${v[0]},${v[1]},${v[2]}`);
	return (v: Voxel) => {
		if (v[7] !== 1) return { top: true, left: true, right: true };
		return {
			top: !full.has(`${v[0]},${v[1] + 1},${v[2]}`),
			left: !full.has(`${v[0]},${v[1]},${v[2] + 1}`),
			right: !full.has(`${v[0] + 1},${v[1]},${v[2]}`),
		};
	};
}

const lit = (v: Voxel, k: number) => {
	const g = v[6];
	return [0, 1, 2].map(i => Math.min(255, Math.round((v[3 + i] * (k + (1 - k) * g * 0.7) + g * 0.12) * 255)));
};

// Paints voxels back to front with Canvas 2D.
export function paint(ctx: CanvasRenderingContext2D, voxels: Voxel[], f: Frame) {
	const faces = visibleFaces(voxels);
	const sorted = [...voxels].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
	const poly = (points: [number, number, number][], rgb: number[]) => {
		ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
		ctx.beginPath();
		points.forEach(([x, y, z], i) => { const [px, py] = project(x, y, z, f); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
		ctx.closePath();
		ctx.fill();
		// A hairline of the same colour hides seams between neighbours.
		ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.stroke();
	};
	for (const v of sorted) {
		const h = v[7] / 2;
		const cx = v[0] + 0.5, cy = v[1] + 0.5, cz = v[2] + 0.5;
		const x0 = cx - h, x1 = cx + h, y0 = cy - h, y1 = cy + h, z0 = cz - h, z1 = cz + h;
		const show = faces(v);
		if (show.right) poly([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], lit(v, shade.right));
		if (show.left) poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], lit(v, shade.left));
		if (show.top) poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], lit(v, shade.top));
	}
}

// The same voxels as a static SVG, for the logo.
export function toSVG(voxels: Voxel[]) {
	const f: Frame = { unit: 10, x: 0, y: 0 };
	const faces = visibleFaces(voxels);
	const sorted = [...voxels].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
	const polys: { points: [number, number][]; fill: string }[] = [];
	for (const v of sorted) {
		const h = v[7] / 2;
		const cx = v[0] + 0.5, cy = v[1] + 0.5, cz = v[2] + 0.5;
		const x0 = cx - h, x1 = cx + h, y0 = cy - h, y1 = cy + h, z0 = cz - h, z1 = cz + h;
		const show = faces(v);
		const add = (pts: [number, number, number][], k: number) => {
			const rgb = lit(v, k);
			polys.push({ points: pts.map(([x, y, z]) => project(x, y, z, f)), fill: `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}` });
		};
		if (show.right) add([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], shade.right);
		if (show.left) add([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], shade.left);
		if (show.top) add([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade.top);
	}
	const xs = polys.flatMap(p => p.points.map(q => q[0])), ys = polys.flatMap(p => p.points.map(q => q[1]));
	const minX = Math.min(...xs), minY = Math.min(...ys);
	const width = Math.max(...xs) - minX, height = Math.max(...ys) - minY;
	return {
		viewBox: `${minX.toFixed(1)} ${minY.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`,
		width, height,
		polys: polys.map(p => ({ d: `M${p.points.map(q => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('L')}Z`, fill: p.fill })),
	};
}
