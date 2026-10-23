import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'node:path';
import { connect, mobBinary, type Connection } from './connection';
import { calfBitmap } from './icon';

const binary = mobBinary(process.resourcesPath);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let connection: Connection | undefined;
let quitting = false;

function icon(scale: number) {
	const { width, height, data } = calfBitmap(scale);
	return nativeImage.createFromBitmap(data, { width, height });
}

// Links that leave the service open in the system browser; the window only
// ever shows Mob.
function external(url: string) {
	if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

function errorPage(message: string) {
	const escaped = message.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
	return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Mob</title><body style="font:15px system-ui;background:#f9f9f7;color:#222;padding:48px"><h1>Mob could not start.</h1><pre style="white-space:pre-wrap">${escaped}</pre><p>Check <code>mob status</code> and the background log, then reopen Mob.</p>`);
}

async function open() {
	if (window) { window.show(); window.focus(); return; }
	window = new BrowserWindow({
		title: 'Mob', width: 1100, height: 780, minWidth: 640, minHeight: 480, backgroundColor: '#f9f9f7', icon: icon(8),
		webPreferences: { preload: join(app.getAppPath(), 'dist', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
	});
	window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window?.hide(); } });
	window.on('closed', () => { window = undefined; });
	window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
	window.webContents.on('will-navigate', (event, url) => {
		if (connection && new URL(url).origin === connection.url) return;
		event.preventDefault(); external(url);
	});
	try {
		connection = await connect(binary);
		await window.loadURL(connection.url + '/');
	} catch (e) {
		await window.loadURL(errorPage(e instanceof Error ? e.message : String(e)));
	}
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on('second-instance', () => void open());
	// The token is read again each time, so a reloaded window follows mob token rotate.
	ipcMain.handle('mob:connection', async () => (connection = await connect(binary)));
	app.on('before-quit', () => { quitting = true; });
	app.on('window-all-closed', () => { if (!tray) app.quit(); });
	app.on('activate', () => void open());
	app.whenReady().then(() => {
		tray = new Tray(icon(1));
		tray.setToolTip('Mob');
		tray.setContextMenu(Menu.buildFromTemplate([
			{ label: 'Open Mob', click: () => void open() },
			{ type: 'separator' },
			{ label: 'Quit', click: () => app.quit() },
		]));
		tray.on('click', () => void open());
		return open();
	}).catch(e => { dialog.showErrorBox('Mob', String(e)); app.quit(); });
}
