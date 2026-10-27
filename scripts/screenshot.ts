// Capture a page of the web app the same way every time: each size in each
// theme, at twice the pixel density, with motion reduced. See docs/screenshots.md.
//
//   bun scripts/screenshot.ts http://127.0.0.1:5173/ --name workspace
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sizes = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };
type Size = keyof typeof sizes;
const themes = ['light', 'dark'] as const;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		name: { type: 'string', default: 'page' },
		// Outside the repository by default, so captures are not committed by accident.
		out: { type: 'string', default: path.join(tmpdir(), 'mob-screenshots') },
		sizes: { type: 'string', default: 'desktop,mobile' },
		themes: { type: 'string', default: themes.join(',') },
		// A selector to wait for before capturing; without one, the page settles for --delay.
		wait: { type: 'string' },
		delay: { type: 'string', default: '1500' },
		// localStorage entries set before the page loads, such as mob-browser-limits-seen=1.
		storage: { type: 'string', multiple: true, default: [] },
		full: { type: 'boolean', default: false },
	},
});
const url = positionals[0];
if (!url) throw new Error('Usage: bun scripts/screenshot.ts <url> [--name n] [--out dir] [--sizes desktop,mobile] [--themes light,dark] [--wait selector] [--storage key=value] [--full]');

// Playwright is not a dependency: cloud sessions have it with Chromium installed, and elsewhere
// `bunx playwright install chromium` with `bun add -g playwright` provides it.
const { chromium } = await import('playwright');
const storage = Object.fromEntries(values.storage.map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
await mkdir(values.out, { recursive: true });
const browser = await chromium.launch();
try {
	for (const size of values.sizes.split(',') as Size[]) {
		for (const theme of values.themes.split(',')) {
			const context = await browser.newContext({ viewport: sizes[size], deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: theme === 'dark' ? 'dark' : 'light' });
			// The site keeps the chosen theme where the docs site does.
			await context.addInitScript((entries) => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, { 'starlight-theme': theme, ...storage });
			const page = await context.newPage();
			// Not networkidle: the change stream stays open.
			await page.goto(url, { waitUntil: 'load' });
			if (values.wait) await page.locator(values.wait).first().waitFor();
			else await page.waitForTimeout(Number(values.delay));
			const file = path.join(values.out, `${values.name}-${size}-${theme}.png`);
			await page.screenshot({ path: file, fullPage: values.full });
			console.log(file);
			await context.close();
		}
	}
} finally {
	await browser.close();
}
