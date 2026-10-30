import { calfColors, calfHead } from '@mob/ui/brand/calfHead';

// calfBitmap draws the logo at scale pixels per cell as BGRA, the layout
// Electron's nativeImage.createFromBitmap takes.
export function calfBitmap(scale: number): { width: number; height: number; data: Buffer } {
	const size = calfHead.length * scale;
	const data = Buffer.alloc(size * size * 4);
	calfHead.forEach((row, y) => [...row].forEach((cell, x) => {
		const color = calfColors[cell];
		if (!color) return;
		const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
		for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
			const at = ((y * scale + dy) * size + x * scale + dx) * 4;
			data[at] = b; data[at + 1] = g; data[at + 2] = r; data[at + 3] = 255;
		}
	}));
	return { width: size, height: size, data };
}
