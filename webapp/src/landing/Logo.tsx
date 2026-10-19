import { calf, calves } from './voxel/model';
import { toSVG } from './voxel/project';

// The Mob calf: the head of the lime voxel calf, drawn once as SVG. Frame 1
// keeps its eyes open.
const head = toSVG(calf(calves.lime, 'idle', 1).filter(v => v[1] >= 7));

export function Calf({ size = 28, className }: { size?: number; className?: string }) {
	return (
		<svg className={className} width={size} height={(size / head.width) * head.height} viewBox={head.viewBox} shapeRendering="crispEdges" aria-hidden="true">
			{head.polys.map((p, i) => <path key={i} d={p.d} fill={p.fill} />)}
		</svg>
	);
}

export function Logo({ size = 30 }: { size?: number }) {
	return <span className="logo"><Calf size={size} /><span className="logo-word">mob</span></span>;
}
