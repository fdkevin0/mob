import { calf } from './pixels';

const fills: Record<string, string> = { h: '#f4f6ef', '#': '#c8f560', s: '#1c2412', o: '#07080a', m: '#ffc4b4', n: '#07080a' };

// The Mob calf, drawn from its pixel map.
export function Calf({ size = 28, className }: { size?: number; className?: string }) {
	const width = calf[0].length;
	return (
		<svg className={className} width={size} height={(size / width) * calf.length} viewBox={`0 0 ${width} ${calf.length}`} shapeRendering="crispEdges" aria-hidden="true">
			{calf.flatMap((row, y) => [...row].map((c, x) => fills[c] ? <rect key={`${x}.${y}`} x={x} y={y} width={1.02} height={1.02} fill={fills[c]} /> : null))}
		</svg>
	);
}

export function Logo({ size = 30 }: { size?: number }) {
	return <span className="logo"><Calf size={size} /><span className="logo-word">mob</span></span>;
}
