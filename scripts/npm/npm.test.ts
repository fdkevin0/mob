// The npm install and publish paths of scripts/npm, against fixture packages
// and a fake npm command, so no registry is needed.
import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const here = import.meta.dir;
const platformPackage = `usemob-${process.platform}-${process.arch}`;
// The fixtures are shell scripts.
const unix = test.skipIf(process.platform === 'win32');

// node_modules with usemob and, unless left out, a platform package whose
// "binary" is a shell script printing native.
function fixture(withBinary: boolean) {
	const modules = join(mkdtempSync(join(tmpdir(), 'usemob-')), 'node_modules');
	const bin = join(modules, 'usemob', 'bin');
	mkdirSync(bin, { recursive: true });
	for (const file of ['mob.js', 'install.js']) copyFileSync(join(here, file), join(bin, file));
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

unix('publish follows publish.json, platform packages first, and skips published versions', () => {
	const root = mkdtempSync(join(tmpdir(), 'usemob-publish-'));
	const out = join(root, 'npm');
	const packages = ['usemob-linux-x64', 'usemob-darwin-arm64', 'usemob'];
	for (const name of packages) mkdirSync(join(out, name), { recursive: true });
	writeFileSync(join(out, 'publish.json'), JSON.stringify({ version: '1.2.3', tag: 'latest', packages }));
	// A fake npm: `view usemob-linux-x64@1.2.3` finds it published; publish logs its directory.
	const fake = join(root, 'bin');
	const log = join(root, 'log');
	mkdirSync(fake);
	writeFileSync(join(fake, 'npm'), `#!/bin/sh
if [ "$1" = view ]; then [ "$2" = usemob-linux-x64@1.2.3 ] && echo 1.2.3; exit 0; fi
echo "$(basename "$PWD") $*" >> ${JSON.stringify(log)}
`);
	chmodSync(join(fake, 'npm'), 0o755);
	const run = Bun.spawnSync(['bun', join(here, 'publish.ts'), '--dir', out], {
		env: { ...process.env, NPM_TOKEN: 'test', PATH: fake + delimiter + process.env.PATH },
	});
	expect(run.exitCode).toBe(0);
	expect(readFileSync(log, 'utf8')).toBe([
		'usemob-darwin-arm64 publish --access public --provenance --tag latest',
		'usemob publish --access public --provenance --tag latest',
		'',
	].join('\n'));
	expect(run.stdout.toString()).toContain('usemob-linux-x64@1.2.3 is already published');
});
