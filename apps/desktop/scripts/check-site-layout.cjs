// Reuse Electron's browser to check the public build served by check-site.ts.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
app.setPath('userData', process.argv.at(-1));
app.on('window-all-closed', () => {});

async function inspect() {
	await document.fonts.ready;
	const header = document.querySelector('.site-header');
	const search = document.querySelector('site-search button[data-open-modal]');
	const rect = element => {
		const { x, y, right, bottom, width, height } = element.getBoundingClientRect();
		return { x, y, right, bottom, width, height };
	};
	const controls = ['.site-brand', '.site-links', 'site-search button[data-open-modal]', '.site-theme .theme-picker', '.site-account', '.sl-menu-button']
		.map(selector => ({ selector, ...rect(document.querySelector(selector)) })).filter(box => box.width > 0);
	return { header: rect(header), search: rect(search), inside: header.contains(search), controls };
}

app.whenReady().then(async () => {
	for (const defaultFontSize of [16, 20, 24]) {
		const window = new BrowserWindow({ show: false, useContentSize: true, webPreferences: { defaultFontSize, backgroundThrottling: false } });
		try {
			for (const width of [320, 390, 760, 790, 800, 950, 1024, 1280]) {
				window.setContentSize(width, 900);
				await window.loadURL(new URL('/docs/', process.argv.at(-2)).href);
				const { header, search, inside, controls } = await window.webContents.executeJavaScript(`(${inspect.toString()})()`);
				const context = `width=${width}, defaultFontSize=${defaultFontSize}`;
				assert(inside, `${context}: search is outside the shared header`);
				assert(Math.abs(search.y + search.height / 2 - controls[0].y - controls[0].height / 2) < 1, `${context}: search is not on the brand row`);
				for (const box of controls) {
					assert(box.x >= header.x && box.right <= header.right + 0.5 && box.bottom <= header.bottom + 0.5, `${context}: ${box.selector} leaves the header`);
				}
				for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
					const a = controls[i], b = controls[j];
					assert(a.right <= b.x + 0.5 || b.right <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5,
						`${context}: ${a.selector} overlaps ${b.selector}: ${JSON.stringify({ a, b })}`);
				}
			}
		} finally {
			window.destroy();
		}
	}
	console.log('Public site header layout passed (24 viewport/font combinations)');
	app.exit(0);
}).catch(error => {
	console.error(error);
	app.exit(1);
});
