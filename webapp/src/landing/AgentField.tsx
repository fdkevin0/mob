import { useEffect, useRef } from 'react';
import { createRenderer, type Renderer } from './gpu';
import { buildScene, framing, particleAt, project, type Scene, type Vec3 } from './scene';

// Draws the same scene with Canvas 2D where WebGPU is missing.
function fallback(canvas: HTMLCanvasElement, scene: Scene): Renderer | undefined {
	const ctx = canvas.getContext('2d');
	if (!ctx) return undefined;
	let width = 1, height = 1, ratio = 1;
	const rgba = (data: Float32Array, o: number, alpha: number) => `rgba(${data[o] * 255 | 0}, ${data[o + 1] * 255 | 0}, ${data[o + 2] * 255 | 0}, ${alpha})`;
	return {
		resize(w, h, r) { width = w; height = h; ratio = r; canvas.width = Math.round(w * r); canvas.height = Math.round(h * r); },
		draw(time) {
			const frame = framing(width, height);
			ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
			ctx.clearRect(0, 0, width, height);
			ctx.globalCompositeOperation = 'lighter';
			ctx.lineWidth = 1;
			const d = scene.lines;
			for (let o = 0; o < d.length; o += 16) {
				const a: Vec3 = [d[o], d[o + 1], d[o + 2]];
				const b: Vec3 = [d[o + 8], d[o + 9], d[o + 10]];
				const phase = d[o + 7];
				let alpha = d[o + 6] * (1 - Math.min(1, Math.max(0, (Math.hypot(a[0], a[2]) - 7) / 5)));
				if (phase >= 0) alpha *= 0.6 + 0.4 * Math.sin(time * 1.7 + phase * 1.3);
				if (alpha <= 0.005) continue;
				const [ax, ay] = project(a, frame), [bx, by] = project(b, frame);
				ctx.strokeStyle = rgba(d, o + 3, alpha);
				ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
			}
			const p = scene.particles;
			for (let i = 0; i < p.length / 8; i++) {
				const { at, fade } = particleAt(scene, i, time);
				const alpha = p[i * 8 + 7] * fade;
				if (alpha <= 0.01) continue;
				const [x, y] = project(at, frame);
				const r = p[i * 8 + 3] * 0.55;
				ctx.fillStyle = rgba(p, i * 8 + 4, alpha * 0.8);
				ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
			}
			ctx.globalCompositeOperation = 'source-over';
		},
		destroy() {},
	};
}

export function AgentField({ className }: { className?: string }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		const scene = buildScene();
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		let renderer: Renderer | undefined, frame = 0, visible = true, gone = false;
		const started = performance.now();
		const draw = () => renderer?.draw(still ? 4.2 : (performance.now() - started) / 1000);
		const loop = () => { draw(); if (!still && visible && !gone) frame = requestAnimationFrame(loop); };
		const resize = () => { renderer?.resize(element.clientWidth, element.clientHeight, Math.min(window.devicePixelRatio || 1, 2)); draw(); };
		const observer = new ResizeObserver(resize);
		const seen = new IntersectionObserver(([entry]) => {
			const was = visible; visible = entry.isIntersecting;
			if (visible && !was && !still) frame = requestAnimationFrame(loop);
		});
		createRenderer(element, scene).catch(() => undefined).then(gpu => {
			if (gone) { gpu?.destroy(); return; }
			renderer = gpu ?? fallback(element, scene);
			element.dataset.renderer = gpu ? 'webgpu' : 'canvas';
			observer.observe(element);
			seen.observe(element);
			resize();
			frame = requestAnimationFrame(loop);
		});
		return () => { gone = true; cancelAnimationFrame(frame); observer.disconnect(); seen.disconnect(); renderer?.destroy(); };
	}, []);
	return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
