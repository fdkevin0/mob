import { calfColors, calfHead } from './calfHead';

// The Mob calf, head on.
export function Calf({ size = 28, className }: { size?: number; className?: string }) {
	const width = calfHead[0].length;
	return (
		<svg className={className} width={size} height={(size / width) * calfHead.length} viewBox={`0 0 ${width} ${calfHead.length}`} shapeRendering="crispEdges" aria-hidden="true">
			{calfHead.flatMap((row, y) => [...row].map((c, x) => calfColors[c] ? <rect key={`${x}.${y}`} x={x} y={y} width={1.02} height={1.02} fill={calfColors[c]} /> : null))}
		</svg>
	);
}

export function Logo({ size = 30 }: { size?: number }) {
	return <span className="logo"><Calf size={size} /><span className="logo-word">mob</span></span>;
}
