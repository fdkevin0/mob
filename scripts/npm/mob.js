#!/usr/bin/env node
// The `mob` command of the usemob npm package until scripts/npm/install.js
// replaces it with the binary, and on Windows. npm and bun install only the
// platform package that matches this machine (@usemob/OS-ARCH); this runs its
// compiled binary, which needs neither Node.js nor Bun.
'use strict';
const { spawn } = require('node:child_process');
const { binaryPath, platformPackage } = require('./platform.js');

let binary;
try {
	binary = binaryPath();
} catch {
	console.error(`mob: ${platformPackage} is not installed. Mob is published for linux-x64, linux-arm64 (glibc and musl), darwin-x64, darwin-arm64 and win32-x64;`);
	console.error('reinstall without --no-optional, or download an archive from https://github.com/fdkevin0/mob/releases');
	process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
// Ctrl+C already reaches the binary through the terminal; other signals are passed on.
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', error => {
	console.error(`mob: ${error.message}`);
	process.exit(1);
});
child.on('exit', (code, signal) => {
	if (signal) {
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	} else process.exit(code ?? 1);
});
