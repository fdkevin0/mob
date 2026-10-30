// Builds every Mob release archive (docs/features/releases.md). The web UI must
// be built first (bun run build) so that it is embedded in each binary.
//
//   bun scripts/release.ts --version V [--only linux_amd64] [--npm]
//
// Writes dist/mob_V_OS_ARCH.{tar.gz,zip} and dist/SHA256SUMS. With --npm, also
// writes the usemob npm package and one usemob-OS-ARCH package per binary to
// dist/npm for scripts/npm/publish.ts.
import { $ } from 'bun';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { version: { type: 'string' }, only: { type: 'string', multiple: true }, npm: { type: 'boolean' } } });
const version = values.version;
if (!version) throw new Error('--version is required');
const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');

type Target = { os: 'linux' | 'darwin' | 'windows'; arch: 'amd64' | 'arm64'; bun: string };
const targets: Target[] = [
	{ os: 'linux', arch: 'amd64', bun: 'bun-linux-x64' },
	{ os: 'linux', arch: 'arm64', bun: 'bun-linux-arm64' },
	{ os: 'darwin', arch: 'amd64', bun: 'bun-darwin-x64' },
	{ os: 'darwin', arch: 'arm64', bun: 'bun-darwin-arm64' },
	{ os: 'windows', arch: 'amd64', bun: 'bun-windows-x64' },
].filter(t => !values.only || values.only.includes(`${t.os}_${t.arch}`)) as Target[];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const archives: string[] = [];
for (const t of targets) {
	const name = `mob_${version}_${t.os}_${t.arch}`;
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
	// npm wants semver: a stable vX.Y.Z is X.Y.Z under the latest tag, and a
	// nightly {date}.{sha} is 0.0.0-nightly.{date}-{sha} under the nightly tag.
	const stable = /^v?(\d+\.\d+\.\d+)$/.exec(version);
	const npmVersion = stable ? stable[1] : `0.0.0-nightly.${version.replace('.', '-')}`;
	const tag = stable ? 'latest' : 'nightly';
	const out = join(dist, 'npm');
	const meta = {
		license: 'MIT',
		homepage: 'https://usemob.app',
		repository: { type: 'git', url: 'git+https://github.com/fdkevin0/mob.git' },
	};
	const platform = (t: Target) => ({ os: t.os === 'windows' ? 'win32' : t.os, cpu: t.arch === 'amd64' ? 'x64' : 'arm64' });
	const packages: string[] = [];
	for (const t of targets) {
		const { os, cpu } = platform(t);
		const name = `usemob-${os}-${cpu}`;
		const dir = join(out, name);
		const exe = t.os === 'windows' ? 'mob.exe' : 'mob';
		mkdirSync(join(dir, 'bin'), { recursive: true });
		copyFileSync(join(dist, `mob_${version}_${t.os}_${t.arch}`, exe), join(dir, 'bin', exe));
		copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
		await Bun.write(join(dir, 'README.md'), `# ${name}\n\nThe ${os}-${cpu} binary of [Mob](https://usemob.app). Install \`usemob\` instead.\n`);
		await Bun.write(join(dir, 'package.json'), JSON.stringify({ name, version: npmVersion, description: `The ${os}-${cpu} binary of Mob`, ...meta, os: [os], cpu: [cpu], files: ['bin'] }, null, '\t') + '\n');
		packages.push(dir);
	}
	const main = join(out, 'usemob');
	mkdirSync(join(main, 'bin'), { recursive: true });
	copyFileSync(join(root, 'scripts/npm/mob.js'), join(main, 'bin', 'mob.js'));
	for (const file of ['LICENSE', 'README.md']) copyFileSync(join(root, file), join(main, file));
	await Bun.write(join(main, 'package.json'), JSON.stringify({
		name: 'usemob',
		version: npmVersion,
		description: 'Local assistant with desktop, terminal and background service',
		...meta,
		bin: { mob: 'bin/mob.js' },
		files: ['bin'],
		optionalDependencies: Object.fromEntries(targets.map(t => { const { os, cpu } = platform(t); return [`usemob-${os}-${cpu}`, npmVersion]; })),
	}, null, '\t') + '\n');
	// scripts/npm/publish.ts publishes them in this order, so usemob never names a missing platform package.
	packages.push(main);
	await Bun.write(join(out, 'publish.json'), JSON.stringify({ version: npmVersion, tag, packages: packages.map(p => p.slice(out.length + 1)) }, null, '\t') + '\n');
	console.log(`Wrote ${packages.length} npm packages ${npmVersion} in ${out}`);

}
