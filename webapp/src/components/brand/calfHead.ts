// The Mob logo: an orange calf head on, after the 牛来的 meme, drawn as pixel art.
// t top of the head, # hide, s shaded hide, p inner ear, b brow, w eye white,
// k pupil, m muzzle, M shaded muzzle, n nostril, c chin.
export const calfHead = [
	'.....tttttt.....',
	'...tttttttttt...',
	'#p.##########.p#',
	'#pp##########pp#',
	'.#p##########p#.',
	'..############s.',
	'..#bbbb##bbbb#s.',
	'..##wkw##wkw##s.',
	'..############s.',
	'..#mmmmmmmmmm#s.',
	'.#mmmmmmmmmmmm#.',
	'.#mMnmmmmmmnMm#.',
	'.#mmmmmmmmmmmm#.',
	'..#MmmmmmmmmM#..',
	'...#cccccccc#...',
	'....########....',
];

export const calfColors: Record<string, string> = {
	t: '#ffa04a', '#': '#f2852b', s: '#d2661c', p: '#f6b39a', b: '#3b2214', w: '#f6efe4',
	k: '#2b170c', m: '#f7d2ad', M: '#e4b086', n: '#c8835f', c: '#f4dfc4',
};

export function calfHeadSVG(attrs = '') {
	const rects = calfHead.flatMap((row, y) => [...row].map((c, x) => calfColors[c] ? `<rect x='${x}' y='${y}' width='1.02' height='1.02' fill='${calfColors[c]}'/>` : ''));
	return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${calfHead[0].length} ${calfHead.length}' shape-rendering='crispEdges'${attrs}>${rects.join('')}</svg>`;
}
