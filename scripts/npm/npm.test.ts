// The npm install and publish paths of scripts/npm, against fixture packages
// and a fake npm command, so no registry is needed.
import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
// The package name the launcher looks for on this machine.
import { isMusl, platformPackage } from './platform.js';

const here = import.meta.dir;
// The fixtures are shell scripts.
const unix = test.skipIf(process.platform === 'win32');

// node_modules with usemob and, unless left out, a platform package whose
// "binary" is a shell script printing native.
function fixture(withBinary: boolean) {
	const modules = join(mkdtempSync(join(tmpdir(), 'usemob-')), 'node_modules');
	const bin = join(modules, 'usemob', 'bin');
	mkdirSync(bin, { recursive: true });
	for (const file of ['mob.js', 'install.js', 'platform.js']) copyFileSync(join(here, file), join(bin, file));
	if (withBinary) {
		const dir = join(modules, platformPackage, 'bin');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'mob'), '#!/bin/sh\necho "native $*"\n');
		chmodSync(join(dir, 'mob'), 0o755);
	}
	return bin;
}

unix('postinstall puts the binary in place of the launcher', () => {
	const bin = fixture(true);
	const install = Bun.spawnSync(['bun', join(bin, 'install.js')]);
	expect(install.exitCode).toBe(0);
	expect(install.stderr.toString()).toBe('');
	// Run with an empty PATH: neither Node.js nor Bun is found.
	const run = Bun.spawnSync([join(bin, 'mob.js'), '--version'], { env: { PATH: '' } });
	expect(run.stdout.toString()).toBe('native --version\n');
});

unix('postinstall keeps the launcher and says so without the platform package', () => {
	const bin = fixture(false);
	const before = readFileSync(join(bin, 'mob.js'), 'utf8');
	const install = Bun.spawnSync(['bun', join(bin, 'install.js')]);
	expect(install.exitCode).toBe(0);
	expect(install.stderr.toString()).toContain('kept the Node.js launcher');
	expect(readFileSync(join(bin, 'mob.js'), 'utf8')).toBe(before);
});

unix('the launcher runs the platform binary and passes its exit code', () => {
	const bin = fixture(true);
	const dir = join(bin, '..', '..', platformPackage, 'bin');
	writeFileSync(join(dir, 'mob'), '#!/bin/sh\necho "native $*"\nexit 3\n');
	const run = Bun.spawnSync(['bun', join(bin, 'mob.js'), 'status']);
	expect(run.stdout.toString()).toBe('native status\n');
	expect(run.exitCode).toBe(3);
});

// A fake npm: `view` finds @usemob/linux-x64@1.2.3 published and reports
// `latest`; publish and dist-tag are logged with their directory.
function fakeNpm(root: string, latest: string) {
	const fake = join(root, 'bin');
	mkdirSync(fake);
	writeFileSync(join(fake, 'npm'), `#!/bin/sh
if [ "$1" = view ]; then
	[ "$2" = @usemob/linux-x64@1.2.3 ] && echo 1.2.3
	[ "$3" = dist-tags.latest ] && echo ${latest}
	exit 0
fi
echo "\${PWD#${root}/npm/} $*" >> ${JSON.stringify(join(root, 'log'))}
`);
	chmodSync(join(fake, 'npm'), 0o755);
	return fake;
}

function publish(version: string, tag: string, latest: string) {
	const root = mkdtempSync(join(tmpdir(), 'usemob-publish-'));
	const out = join(root, 'npm');
	const packages = ['@usemob/linux-x64', '@usemob/darwin-arm64', 'usemob'];
	for (const name of packages) mkdirSync(join(out, name), { recursive: true });
	writeFileSync(join(out, 'publish.json'), JSON.stringify({ version, tag, packages }));
	const run = Bun.spawnSync(['bun', join(here, 'publish.ts'), '--dir', out], {
		env: { ...process.env, NPM_TOKEN: 'test', PATH: fakeNpm(root, latest) + delimiter + process.env.PATH },
	});
	expect(run.exitCode).toBe(0);
	return { log: readFileSync(join(root, 'log'), 'utf8').trimEnd().split('\n'), stdout: run.stdout.toString() };
}

unix('publish follows publish.json, platform packages first, and skips published versions', () => {
	const { log, stdout } = publish('1.2.3', 'latest', '1.2.2');
	expect(log).toEqual([
		'@usemob/darwin-arm64 publish --access public --provenance --tag latest',
		'usemob publish --access public --provenance --tag latest',
	]);
	expect(stdout).toContain('@usemob/linux-x64@1.2.3 is already published');
});

unix('a nightly moves latest only while latest is a nightly', () => {
	const moved = publish('0.3.0-nightly.1.g1', 'nightly', '0.0.0-nightly.20261030-896099c').log;
	expect(moved.at(-1)).toEndWith('dist-tag add usemob@0.3.0-nightly.1.g1 latest');
	const kept = publish('0.3.0-nightly.1.g1', 'nightly', '0.2.0').log;
	expect(kept.at(-1)).toBe('usemob publish --access public --provenance --tag nightly');
});

unix('a rerun of an older nightly does not move latest back', () => {
	const log = publish('0.3.0-nightly.20261030160000.g896099c', 'nightly', '0.3.0-nightly.20261030220535.g5caa651').log;
	expect(log.at(-1)).toBe('usemob publish --access public --provenance --tag nightly');
});

test('the runtime libc decides before a musl loader in /lib', () => {
	const alpine = () => ['ld-musl-x86_64.so.1'];
	expect(isMusl({ header: { glibcVersionRuntime: '2.43' } }, alpine)).toBe(false);
	expect(isMusl({ header: {} }, alpine)).toBe(true);
	expect(isMusl(undefined, alpine)).toBe(true);
	expect(isMusl({ header: {} }, () => ['ld-linux-x86-64.so.2'])).toBe(false);
});
