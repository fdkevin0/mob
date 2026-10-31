// The postinstall script of the usemob npm package. On Linux and macOS it puts
// this machine's binary in place of the bin/mob.js launcher, so `mob` runs
// natively, without Node.js or Bun. npm runs it; Bun runs it with
// `bun add -g --trust usemob`. When it does not run, or fails, the launcher
// stays and needs Node.js; a failure is reported but does not fail the install.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { binaryPath, platformPackage } = require('./platform.js');

if (process.platform !== 'win32') {
	try {
		const binary = binaryPath();
		const launcher = path.join(__dirname, 'mob.js');
		const temp = launcher + '.tmp';
		fs.rmSync(temp, { force: true });
		// A hard link saves a second copy of the binary; across file systems, copy it.
		try { fs.linkSync(binary, temp); } catch { fs.copyFileSync(binary, temp); }
		fs.chmodSync(temp, 0o755);
		// The global bin link points at mob.js, so the binary takes its name.
		fs.renameSync(temp, launcher);
	} catch (error) {
		console.warn(`usemob: kept the Node.js launcher, so mob needs Node.js (${platformPackage}: ${error.code ?? error.message})`);
	}
}
