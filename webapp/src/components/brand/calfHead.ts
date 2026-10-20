// The Mob logo: the voxel calf's head drawn straight on as pixel art.
// h horn, # hide, s shaded hide, d patch, e eye, w eye highlight,
// m muzzle, n nostril.
export const calfHead = [
	'...hh......hh...',
	'...hh......hh...',
	'..##########ss..',
	'######dd######ss',
	'######dd######ss',
	'..######d#####..',
	'..##we####we#s..',
	'..##ee####ee#s..',
	'..###########s..',
	'..#mmmmmmmmmm#..',
	'..#mnnmmmmnnm#..',
	'..#mmmmmmmmmm#..',
	'...##########...',
];

export const calfColors: Record<string, string> = {
	h: '#f6ead0', '#': '#c8f560', s: '#a3cc4a', d: '#5d7f22', e: '#141518', w: '#ffffff', m: '#ffb8ae', n: '#c9665e',
};

export function calfHeadSVG(attrs = '') {
	const rects = calfHead.flatMap((row, y) => [...row].map((c, x) => calfColors[c] ? `<rect x='${x}' y='${y}' width='1.02' height='1.02' fill='${calfColors[c]}'/>` : ''));
	return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${calfHead[0].length} ${calfHead.length}' shape-rendering='crispEdges'${attrs}>${rects.join('')}</svg>`;
}
