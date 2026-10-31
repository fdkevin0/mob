// Finds the binary that npm or bun installed for this machine: the
// @usemob/OS-ARCH package, with -musl on Linux systems that use musl (Alpine).
'use strict';
const fs = require('node:fs');

// The runtime's own libc wins: Node.js and Bun report the glibc they run on,
// and a glibc system can have a musl loader installed too. Only without that
// report does a musl loader in /lib decide, as on Alpine.
function isMusl(report, libEntries) {
	if (report?.header?.glibcVersionRuntime) return false;
	return libEntries().some(name => name.startsWith('ld-musl-'));
}

function runtimeReport() {
	try {
		process.report.excludeNetwork = true;
		return process.report.getReport();
	} catch {
		return undefined;
	}
}

function libEntries() {
	try {
		return fs.readdirSync('/lib');
	} catch {
		return [];
	}
}

exports.isMusl = isMusl;
exports.platformPackage = `@usemob/${process.platform}-${process.arch}${process.platform === 'linux' && isMusl(runtimeReport(), libEntries) ? '-musl' : ''}`;

// Throws when the platform package is not installed.
exports.binaryPath = () => require.resolve(`${exports.platformPackage}/bin/${process.platform === 'win32' ? 'mob.exe' : 'mob'}`);
