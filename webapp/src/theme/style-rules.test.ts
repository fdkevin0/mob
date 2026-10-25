import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The site-wide UI rules from CONTRIBUTING.md ("UI style"), checked over every
// stylesheet of the web app and the docs site.
const root = path.resolve(__dirname, '../../..');
const tokenFiles = new Set(['webapp/src/styles/theme.css', 'apps/docs/src/theme.css']);
const sheets = ['webapp/src', 'apps/docs/src'].flatMap((dir) =>
	readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })
		.filter((file) => file.endsWith('.css'))
		.map((file) => path.posix.join(dir, file.split(path.sep).join('/'))),
);

// Radii off the scale that predate it. The chat styles and the demo's copy of
// them move onto the scale as the demo starts rendering the real chat
// components; lower a count when you remove one, never raise it.
const legacyRadii: Record<string, number> = {
	'webapp/src/chat/styles.css': 31,
	'webapp/src/landing/demo/demo.css': 17,
};
const scale = /^(0|4px|8px|12px|16px|50%|999px|var\(--radius(-code|-card|-dialog|-pill)?\))$/;

function declarations(file: string) {
	const css = readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	return [...css.matchAll(/([-\w]+)\s*:\s*([^;{}]*?)\s*(?=[;}])/g)].map(([, prop, value]) => ({ prop, value }));
}

function splitTop(value: string, separator: RegExp) {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (value[i] === '(') depth++;
		else if (value[i] === ')') depth--;
		else if (depth === 0 && separator.test(value[i])) {
			parts.push(value.slice(start, i));
			start = i + 1;
		}
	}
	return [...parts, value.slice(start)].map((part) => part.trim()).filter(Boolean);
}

// A sharp shadow cast down and to the side. Inset edges and a folded card's
// straight-down stack are borders, not shadows. The colour and `inset` may sit
// on either side of the lengths; a blur written as an expression counts as soft.
const length = /^(-?[\d.]+[a-z]*|(calc|min|max|clamp)\(.*\))$/;
function hardShadow(shadow: string) {
	const parts = splitTop(shadow, /\s/);
	if (parts.includes('inset')) return false;
	const first = parts.findIndex((part) => length.test(part));
	if (first < 0) return false;
	const end = parts.findIndex((part, i) => i > first && !length.test(part));
	const [x, y, blur = '0'] = parts.slice(first, end < 0 ? undefined : end);
	const zero = (part: string) => /^-?0*\.?0*[a-z]*$/.test(part);
	return y !== undefined && !zero(x) && !zero(y) && zero(blur);
}

describe('style rules', () => {
	it('flags hard shadows', () => {
		expect(hardShadow('4px 4px 0 rgb(0 0 0)')).toBe(true);
		expect(hardShadow('0 30px 80px rgb(0 0 0)')).toBe(false);
		expect(hardShadow('var(--text) 4px 4px 0')).toBe(true);
		expect(hardShadow('rgb(0 0 0 / 0.4) 4px 4px')).toBe(true);
		expect(hardShadow('inset 2px 0 0 var(--lime)')).toBe(false);
		expect(hardShadow('4px 4px 0 inset var(--line)')).toBe(false);
		expect(hardShadow('4px 4px calc(8px) var(--line)')).toBe(false);
		expect(hardShadow('0 4px 0 -1px var(--surface)')).toBe(false);
	});

	it('finds the stylesheets', () => {
		expect(sheets).toEqual(expect.arrayContaining([...tokenFiles, 'webapp/src/landing/landing.css', 'webapp/src/chat/styles.css']));
	});

	it('keeps raw colours in the token files', () => {
		const raw = sheets
			.filter((file) => !tokenFiles.has(file))
			.flatMap((file) =>
				declarations(file)
					// A custom property names its colour; a mask only reads alpha.
					.filter(({ prop, value }) => /#[0-9a-f]{3,8}\b/i.test(value) && !prop.startsWith('--') && !/^(-webkit-)?mask/.test(prop))
					.map(({ prop, value }) => `${file}: ${prop}: ${value}`),
			);
		expect(raw).toEqual([]);
	});

	it('keeps radii on the scale', () => {
		const off = new Map<string, string[]>();
		for (const file of sheets.filter((file) => !tokenFiles.has(file))) {
			for (const { prop, value } of declarations(file)) {
				// A control's track wraps its segments, so it may add its padding to a step.
				if (!/^border(-[a-z]+)*-radius$/.test(prop) || /^calc\(var\(--radius[-a-z]*\) \+ \d+px\)$/.test(value)) continue;
				const corners = value.split(/\s+/).filter((corner) => !scale.test(corner));
				if (corners.length) off.set(file, [...(off.get(file) ?? []), value]);
			}
		}
		const counts = Object.fromEntries([...off].map(([file, values]) => [file, values.length]));
		for (const [file, values] of off) {
			expect(values.length, `${file}: ${values.join(', ')}`).toBeLessThanOrEqual(legacyRadii[file] ?? 0);
		}
		expect(Object.keys(counts).sort()).toEqual(Object.keys(legacyRadii).sort());
	});

	it('has no hard offset shadows', () => {
		const hard = sheets.flatMap((file) =>
			declarations(file)
				.filter(({ prop }) => prop === 'box-shadow')
				.flatMap(({ value }) => splitTop(value, /,/).map((shadow) => ({ file, shadow }))),
		).filter(({ shadow }) => hardShadow(shadow));
		expect(hard.map(({ file, shadow }) => `${file}: ${shadow}`)).toEqual([]);
	});
});
