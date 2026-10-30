// The postinstall script of the usemob npm package. On Linux and macOS it puts
// this machine's binary in place of the bin/mob.js launcher, so `mob` runs
// natively, without Node.js or Bun. npm runs it; Bun runs it with
// `bun add -g --trust usemob`. When it does not run, or fails, the launcher stays.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
	try {
		const binary = require.resolve(`usemob-${process.platform}-${process.arch}/bin/mob`);
		const launcher = path.join(__dirname, 'mob.js');
		const temp = launcher + '.tmp';
		fs.rmSync(temp, { force: true });
		// A hard link saves a second copy of the binary; across file systems, copy it.
		try { fs.linkSync(binary, temp); } catch { fs.copyFileSync(binary, temp); }
		fs.chmodSync(temp, 0o755);
		// The global bin link points at mob.js, so the binary takes its name.
		fs.renameSync(temp, launcher);
	} catch {
		// Keep the launcher.
	}
}
