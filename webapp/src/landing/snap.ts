// The story's pages hold the scroll like magnets. Touch and the keyboard get
// the browser's own scroll snapping (landing.css), which on phones is the
// system's paging physics. A mouse wheel or trackpad turns one page per
// gesture instead, on a spring that starts from the gesture's push, so it
// never stops and then moves again the way snapping after the fact does.

// The page next to `from` in direction dir, if there is one.
export function adjacent(points: number[], from: number, dir: number): number | undefined {
	return dir > 0 ? points.find(p => p > from + 1) : points.findLast(p => p < from - 1);
}

// A critically damped spring towards 0: where it is and how fast it moves
// (per second) t seconds after starting at x with speed v. It never
// overshoots while v is below omega * |x| towards 0.
export function spring(x: number, v: number, omega: number, t: number): [number, number] {
	const c = v + omega * x, e = Math.exp(-omega * t);
	return [(x + c * t) * e, (c - omega * (x + c * t)) * e];
}

// Tells a fresh wheel gesture from more of the same one: the rest of a burst
// of notches, or the momentum a trackpad keeps sending after the fingers
// lift, which dies away a little with every event. A new gesture is a pause,
// a change of direction, or a push well above that dying tail.
export class Gestures {
	private last = -Infinity;
	private dir = 0;
	private size = 0;
	private peak = 0;
	private sum = 0;
	// Whether the gesture going on has already turned its page.
	spent = false;

	// Feeds one wheel event at time t (ms); true when it should turn the page.
	feed(dy: number, t: number): boolean {
		const size = Math.abs(dy), dir = Math.sign(dy);
		if (!dir) return false;
		const kick = size > 8 && size > this.size * 2 && this.size < this.peak / 2;
		if (t - this.last > 180 || dir !== this.dir || kick) {
			this.dir = dir;
			this.sum = this.peak = 0;
			this.spent = false;
		}
		this.last = t;
		this.size = size;
		this.peak = Math.max(this.peak, size);
		this.sum += size;
		if (this.spent || this.sum < 24) return false;
		this.spent = true;
		return true;
	}
}

const OMEGA = 9; // settles in about half a second, whatever the distance

// Takes over the wheel while the scroll is on the story's pages, points(),
// whose last one is where the story ends and free scrolling starts again.
export function magnet(points: () => number[]): () => void {
	const root = document.documentElement;
	const gestures = new Gestures();
	let anim = 0;
	let target = 0;
	let from = { x: 0, v: 0, t: 0 }; // the spring's start, relative to target

	// A frame can start a little before the call that set the spring off.
	const at = (now: number) => spring(from.x, from.v, OMEGA, Math.max(0, now - from.t) / 1000);
	const done = () => { anim = 0; root.style.scrollSnapType = ''; };
	const stop = () => { if (anim) { cancelAnimationFrame(anim); done(); } };
	const frame = (now: number) => {
		const [x, v] = at(now);
		const still = Math.abs(x) < 0.5 && Math.abs(v) < 20;
		window.scrollTo({ top: still ? target : target + x, behavior: 'instant' });
		if (still) done();
		else anim = requestAnimationFrame(frame);
	};
	const go = (to: number) => {
		const now = performance.now();
		const [x, v] = anim ? at(now) : [window.scrollY - target, 0];
		const off = target + x - to, dist = Math.abs(off), toward = -Math.sign(off);
		// Set off with a push towards the page, keeping any speed already
		// going that way, but never enough to overshoot it.
		const speed = Math.min(Math.max(v * toward, OMEGA * dist * 0.6), OMEGA * dist * 0.95);
		target = to;
		from = { x: off, v: toward * speed, t: now };
		// The browser's snapping would pull every step back onto a page.
		root.style.scrollSnapType = 'none';
		anim ||= requestAnimationFrame(frame);
	};

	const wheel = (event: WheelEvent) => {
		// Pinch zoom, sideways scrolling, and an open dialog or menu (which
		// locks the page's scroll) are left to the browser.
		if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || document.body.hasAttribute('data-scroll-locked')) return;
		const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
		const pages = points();
		const end = pages[pages.length - 1];
		const y = window.scrollY;
		const turn = gestures.feed(dy, event.timeStamp);
		// Past the story the page scrolls as usual, and comes back in from its
		// end, once the gesture that brought it there is over.
		if (!anim && !(gestures.spent && !turn) && (y > end + 1 || (y >= end - 1 && dy > 0))) return;
		event.preventDefault();
		if (!turn) return;
		const to = adjacent(pages, anim ? target : y, Math.sign(dy));
		if (to !== undefined) go(to);
	};

	window.addEventListener('wheel', wheel, { passive: false });
	window.addEventListener('mousedown', stop);
	window.addEventListener('touchstart', stop, { passive: true });
	return () => {
		stop();
		window.removeEventListener('wheel', wheel);
		window.removeEventListener('mousedown', stop);
		window.removeEventListener('touchstart', stop);
	};
}
