// Builds every Mob release archive (docs/features/releases.md). The web UI must
// be built first (bun run build) so that it is embedded in each binary.
//
//   bun scripts/release.ts --version V [--only linux_amd64] [--npm]
//
// Writes dist/mob_V_OS_ARCH[_musl].{tar.gz,zip} and dist/SHA256SUMS. With --npm,
// also writes the usemob npm package and one @usemob/OS-ARCH[-musl] package per
// binary to dist/npm for scripts/npm/publish.ts.
import { $ } from 'bun';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { version: { type: 'string' }, only: { type: 'string', multiple: true }, npm: { type: 'boolean' } } });
const version = values.version;
if (!version) throw new Error('--version is required');
const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');

// Linux builds come for glibc and for musl (Alpine); `musl` names the second.
type Target = { os: 'linux' | 'darwin' | 'windows'; arch: 'amd64' | 'arm64'; musl?: true; bun: string };
const targets: Target[] = ([
	{ os: 'linux', arch: 'amd64', bun: 'bun-linux-x64' },
	{ os: 'linux', arch: 'arm64', bun: 'bun-linux-arm64' },
	{ os: 'linux', arch: 'amd64', musl: true, bun: 'bun-linux-x64-musl' },
	{ os: 'linux', arch: 'arm64', musl: true, bun: 'bun-linux-arm64-musl' },
	{ os: 'darwin', arch: 'amd64', bun: 'bun-darwin-x64' },
	{ os: 'darwin', arch: 'arm64', bun: 'bun-darwin-arm64' },
	{ os: 'windows', arch: 'amd64', bun: 'bun-windows-x64' },
] as Target[]).filter(t => !values.only || values.only.includes(slug(t)));
function slug(t: Target) {
	return `${t.os}_${t.arch}${t.musl ? '_musl' : ''}`;
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const archives: string[] = [];
for (const t of targets) {
	const name = `mob_${version}_${slug(t)}`;
	const dir = join(dist, name);
	mkdirSync(dir, { recursive: true });
	const binary = join(dir, t.os === 'windows' ? 'mob.exe' : 'mob');
	await $`bun apps/mob/scripts/build.ts --outfile ${binary} --target ${t.bun} --version ${version}`.cwd(root);
	// The source map stays out of the archive; it names build paths, not anything users run.
	rmSync(binary.replace(/(\.exe)?$/, '.map'), { force: true });
	for (const file of ['LICENSE', 'README.md', 'config.example.yaml']) copyFileSync(join(root, file), join(dir, file));
	const archive = name + (t.os === 'windows' ? '.zip' : '.tar.gz');
	if (t.os === 'windows') await $`zip -qr ${archive} ${name}`.cwd(dist);
	else await $`tar -czf ${archive} ${name}`.cwd(dist);
	archives.push(archive);
}

const sums: Record<string, string> = {};
for (const a of archives) sums[a] = new Bun.CryptoHasher('sha256').update(await Bun.file(join(dist, a)).arrayBuffer()).digest('hex');
await Bun.write(join(dist, 'SHA256SUMS'), archives.map(a => `${sums[a]}  ${a}`).join('\n') + '\n');
console.log(`Built ${archives.length} archives in ${dist}`);

if (values.npm) {
	// npm wants semver: a stable vX.Y.Z is X.Y.Z under the latest tag. A nightly
	// is a prerelease of the next minor version, ordered by commit time, under
	// the nightly tag: 0.3.0-nightly.20261030220535.g5caa651 sorts after 0.2.x and
	// before 0.3.0. The g keeps an all-digit hash from reading as a number.
	const stable = /^v?(\d+\.\d+\.\d+)$/.exec(version);
	let npmVersion: string;
	if (stable) npmVersion = stable[1];
	else {
		const [major, minor] = (await Bun.file(join(root, '.release-please-manifest.json')).json())['.'].split('.').map(Number);
		const time = (await $`git show -s --format=%cd --date=format-local:%Y%m%d%H%M%S HEAD`.cwd(root).env({ ...process.env, TZ: 'UTC' }).text()).trim();
		const sha = (await $`git rev-parse --short=7 HEAD`.cwd(root).text()).trim();
		npmVersion = `${major}.${minor + 1}.0-nightly.${time}.g${sha}`;
	}
	const tag = stable ? 'latest' : 'nightly';
	const out = join(dist, 'npm');
	const meta = {
		license: 'MIT',
		homepage: 'https://usemob.app',
		repository: { type: 'git', url: 'git+https://github.com/fdkevin0/mob.git' },
	};
	// The names and fields npm matches against the machine: @usemob/linux-x64-musl
	// has os linux, cpu x64 and libc musl.
	const platform = (t: Target) => {
		const os = t.os === 'windows' ? 'win32' : t.os;
		const cpu = t.arch === 'amd64' ? 'x64' : 'arm64';
		const libc = t.os === 'linux' ? (t.musl ? 'musl' : 'glibc') : undefined;
		return { name: `@usemob/${os}-${cpu}${t.musl ? '-musl' : ''}`, label: `${os}-${cpu}${libc ? ` (${libc})` : ''}`, os, cpu, libc };
	};
	const packages: string[] = [];
	for (const t of targets) {
		const { name, label, os, cpu, libc } = platform(t);
		const dir = join(out, name);
		const exe = t.os === 'windows' ? 'mob.exe' : 'mob';
		mkdirSync(join(dir, 'bin'), { recursive: true });
		copyFileSync(join(dist, `mob_${version}_${slug(t)}`, exe), join(dir, 'bin', exe));
		copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
		await Bun.write(join(dir, 'README.md'), `# ${name}\n\nThe ${label} binary of [Mob](https://usemob.app). Install \`usemob\` instead.\n`);
		await Bun.write(join(dir, 'package.json'), JSON.stringify({
			name, version: npmVersion, description: `The ${label} binary of Mob`, ...meta,
			os: [os], cpu: [cpu], ...(libc ? { libc: [libc] } : {}), files: ['bin'],
		}, null, '\t') + '\n');
		packages.push(dir);
	}
	const main = join(out, 'usemob');
	mkdirSync(join(main, 'bin'), { recursive: true });
	for (const file of ['mob.js', 'install.js', 'platform.js']) copyFileSync(join(root, 'scripts/npm', file), join(main, 'bin', file));
	for (const file of ['LICENSE', 'README.md']) copyFileSync(join(root, file), join(main, file));
	await Bun.write(join(main, 'package.json'), JSON.stringify({
		name: 'usemob',
		version: npmVersion,
		description: 'Local assistant with desktop, terminal and background service',
		...meta,
		bin: { mob: 'bin/mob.js' },
		scripts: { postinstall: 'node bin/install.js' },
		files: ['bin'],
		optionalDependencies: Object.fromEntries(targets.map(t => [platform(t).name, npmVersion])),
	}, null, '\t') + '\n');
	// scripts/npm/publish.ts publishes them in this order, so usemob never names a missing platform package.
	packages.push(main);
	await Bun.write(join(out, 'publish.json'), JSON.stringify({ version: npmVersion, tag, packages: packages.map(p => p.slice(out.length + 1)) }, null, '\t') + '\n');
	console.log(`Wrote ${packages.length} npm packages ${npmVersion} in ${out}`);

}
