import { icons, type IconName } from './pixels';

export function PixelIcon({ name, size = 21, className }: { name: IconName; size?: number; className?: string }) {
	const rows = icons[name];
	const width = rows[0].length;
	return (
		<svg className={className} width={size} height={(size / width) * rows.length} viewBox={`0 0 ${width} ${rows.length}`} shapeRendering="crispEdges" aria-hidden="true">
			{rows.flatMap((row, y) => [...row].map((c, x) => c === '#' ? <rect key={`${x}.${y}`} x={x + 0.06} y={y + 0.06} width={0.88} height={0.88} fill="currentColor" /> : null))}
		</svg>
	);
}
