// Finds the binary that npm or bun installed for this machine: the
// @usemob/OS-ARCH package, with -musl on Linux systems that use musl (Alpine).
'use strict';
const fs = require('node:fs');

function isMusl() {
	if (process.platform !== 'linux') return false;
	try {
		return fs.readdirSync('/lib').some(name => name.startsWith('ld-musl-'));
	} catch {
		return false;
	}
}

exports.platformPackage = `@usemob/${process.platform}-${process.arch}${isMusl() ? '-musl' : ''}`;

// Throws when the platform package is not installed.
exports.binaryPath = () => require.resolve(`${exports.platformPackage}/bin/${process.platform === 'win32' ? 'mob.exe' : 'mob'}`);
