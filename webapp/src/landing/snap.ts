// The story's pages pull the scroll onto them once the user lets go, like
// magnets: CSS scroll snapping only takes the nearest page, often late and
// with a jolt, while this eases in and leans the way the user was going.

// Where to settle from y, given the pages' tops in order and the direction
// the user was scrolling. Between two pages a small push (15% of the way, or
// 48px, about one wheel notch) is enough to go on to the next one; outside
// the pages the scroll is left alone.
export function snapTarget(points: number[], y: number, dir: number): number | undefined {
	if (points.length < 2 || y < points[0] || y > points[points.length - 1]) return undefined;
	let i = 0;
	while (i < points.length - 2 && y >= points[i + 1]) i++;
	const [a, b] = [points[i], points[i + 1]];
	const push = Math.min(48, (b - a) * 0.15);
	const reach = dir > 0 ? a + push : dir < 0 ? b - push : (a + b) / 2;
	const to = y >= reach ? b : a;
	return Math.abs(to - y) < 2 ? undefined : to;
}

const ease = (t: number) => 1 - (1 - t) ** 3;

// Watches the window's scroll and pulls it onto points() whenever it comes to
// rest. Any wheel, touch, key or click takes the scroll back at once.
export function magnet(points: () => number[]): () => void {
	let from = window.scrollY; // where the last gesture started
	let anim = 0;
	let timer = 0;
	let touching = false;

	const stop = () => { if (anim) { cancelAnimationFrame(anim); anim = 0; from = window.scrollY; } };
	const glide = (to: number) => {
		const start = window.scrollY, d = to - start, t0 = performance.now();
		const ms = Math.min(650, Math.max(320, 260 + Math.abs(d) * 0.3));
		const frame = (now: number) => {
			const t = Math.min(1, (now - t0) / ms);
			window.scrollTo({ top: start + d * ease(t), behavior: 'instant' });
			if (t < 1) anim = requestAnimationFrame(frame);
			else { anim = 0; from = to; }
		};
		anim = requestAnimationFrame(frame);
	};
	const settle = () => {
		clearTimeout(timer);
		if (anim || touching) return;
		const y = window.scrollY;
		const to = snapTarget(points(), y, Math.sign(y - from));
		if (to === undefined) from = y;
		else glide(to);
	};
	// Wait a moment after the scroll ends, so the next notch of a mouse wheel
	// or the next swipe carries on instead of being pulled back. Browsers
	// without scrollend settle after a quiet spell instead.
	const later = (ms: number) => { clearTimeout(timer); timer = window.setTimeout(settle, ms); };
	const scrolled = () => { if (!anim) later('onscrollend' in window ? 400 : 180); };
	const ended = () => { if (!anim) later(120); };
	const wheel = () => { stop(); scrolled(); };
	const down = () => { touching = true; stop(); };
	const up = () => { touching = false; scrolled(); };

	const on: [string, EventListener][] = [
		['scroll', scrolled], ['scrollend', ended], ['wheel', wheel], ['keydown', stop], ['mousedown', stop],
		['touchstart', down], ['touchend', up], ['touchcancel', up],
	];
	for (const [name, fn] of on) window.addEventListener(name, fn, { passive: true });
	return () => {
		stop();
		clearTimeout(timer);
		for (const [name, fn] of on) window.removeEventListener(name, fn);
	};
}
