import { useEffect, useRef } from 'react';
import type { Voxel } from './model';
import { paint, type Frame } from './project';
import { createVoxelRenderer, type VoxelRenderer } from './gpu';
import { onThemeApplied } from '../../theme/theme';

type Props = {
	scene: (time: number) => Voxel[];
	frame: (width: number, height: number) => Frame;
	pixel?: number; // CSS pixels per rendered pixel
	gpu?: boolean; // WebGPU when available, Canvas 2D otherwise
	still?: number; // the time shown when motion is reduced
	fps?: number; // at most this many frames a second
	className?: string;
	label?: string;
};

function canvas2d(canvas: HTMLCanvasElement): VoxelRenderer | undefined {
	const ctx = canvas.getContext('2d');
	if (!ctx) return undefined;
	return {
		resize(width, height) { canvas.width = width; canvas.height = height; },
		draw(voxels, frame) { ctx.clearRect(0, 0, canvas.width, canvas.height); paint(ctx, voxels, frame); },
		destroy() {},
	};
}

// A voxel scene drawn small and scaled up, so every voxel is crisp pixels.
export function VoxelCanvas({ scene, frame, pixel = 3, gpu = false, still = 0, fps = 60, className, label }: Props) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		let renderer: VoxelRenderer | undefined, raf = 0, visible = true, gone = false;
		const started = performance.now();
		const draw = () => {
			if (!renderer) return;
			const time = reduced ? still : (performance.now() - started) / 1000;
			renderer.draw(scene(time), frame(element.width, element.height));
		};
		let last = 0;
		const loop = (now: number) => {
			if (now - last >= 1000 / fps - 2) { last = now; draw(); }
			if (!reduced && visible && !gone) raf = requestAnimationFrame(loop);
		};
		const resize = () => {
			renderer?.resize(Math.ceil(element.clientWidth / pixel), Math.ceil(element.clientHeight / pixel));
			draw();
		};
		const observer = new ResizeObserver(resize);
		const seen = new IntersectionObserver(([entry]) => {
			const was = visible; visible = entry.isIntersecting;
			if (visible && !was && !reduced && !gone) raf = requestAnimationFrame(loop);
		});
		(gpu ? createVoxelRenderer(element).catch(() => undefined) : Promise.resolve(undefined)).then(found => {
			if (gone) { found?.destroy(); return; }
			renderer = found ?? canvas2d(element);
			element.dataset.renderer = found ? 'webgpu' : 'canvas';
			observer.observe(element);
			seen.observe(element);
			resize();
			raf = requestAnimationFrame(loop);
		});
		// The scene's colours follow the page's scheme; a still scene (reduced
		// motion) is drawn again when it changes.
		const unwatch = onThemeApplied(draw);
		return () => { gone = true; cancelAnimationFrame(raf); unwatch(); observer.disconnect(); seen.disconnect(); renderer?.destroy(); };
	}, [scene, frame, pixel, gpu, still, fps]);
	return <canvas ref={ref} className={className} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
