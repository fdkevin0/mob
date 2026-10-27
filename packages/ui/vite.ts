import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

// Each page asks for its Latin Geist face in <head>, so they arrive with the
// stylesheet instead of after it and the first paint already uses them.
export const preloadFonts: Plugin = {
	name: 'mob:preload-fonts',
	apply: 'build',
	transformIndexHtml: {
		order: 'post',
		handler: (_html, { bundle }) => Object.keys(bundle ?? {})
			.filter(file => /\/geist-latin-wght-normal-[\w-]+\.woff2$/.test(file))
			.map(file => ({ tag: 'link', attrs: { rel: 'preload', href: '/' + file, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' as const })),
	},
};

// Vite rewrites a page's entry script and drops blocking="render" on the way;
// this puts it back on the built tag for each page whose source asks for it.
export const renderBlocking: Plugin = {
	name: 'mob:render-blocking',
	apply: 'build',
	transformIndexHtml: {
		order: 'post',
		handler: (html, { filename }) => readFileSync(filename, 'utf8').includes('blocking="render"')
			? html.replace(/<script type="module" crossorigin src=/, '<script type="module" blocking="render" crossorigin src=')
			: html,
	},
};
