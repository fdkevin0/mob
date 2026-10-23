// The autopilot's pointer, a pixel arrow that glides to what it clicks.
export type Aim = { x: number; y: number; press: boolean };

export function Cursor({ at }: { at: Aim }) {
	return (
		<svg className={`demo-cursor${at.press ? ' press' : ''}`} style={{ transform: `translate(${at.x}px, ${at.y}px)` }} width="22" height="22" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
			{/* The press squeezes the arrow, not the translate that places it. */}
			<g>
				<path d="M1 1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1H8v1h1v2h1v2H8v-2H7v-2H6v1H5v1H4v1H1z" fill="#0a0d05" />
				<path d="M2 3h1v1h1v1h1v1h1v1h1v1h1v1h1v1H7v1h1v2H8v-1H7v-2H6v1H5v1H4v1H2z" fill="#f4f6ef" />
			</g>
		</svg>
	);
}

/** aimAt places the pointer over el, in stage's coordinates. */
export function aimAt(el: Element | null, stage: Element | null, press: boolean): Aim | undefined {
	if (!el || !stage) return undefined;
	const r = el.getBoundingClientRect(), b = stage.getBoundingClientRect();
	return { x: r.left - b.left + r.width * 0.55, y: r.top - b.top + r.height * 0.6, press };
}
