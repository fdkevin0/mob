// Builds every Mob release archive (docs/features/releases.md). The web UI must
// be built first (bun run build) so that it is embedded in each binary.
//
//   bun scripts/release.ts --version V [--only linux_amd64] [--cask]
//
// Writes dist/mob_V_OS_ARCH.{tar.gz,zip} and dist/SHA256SUMS. With --cask and
// HOMEBREW_TAP_TOKEN set, also publishes the Homebrew cask to fdkevin0/homebrew-tap.
import { $ } from 'bun';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { version: { type: 'string' }, only: { type: 'string', multiple: true }, cask: { type: 'boolean' } } });
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

if (values.cask) {
	const tag = version;
	const url = (os: string, arch: string) => `https://github.com/fdkevin0/mob/releases/download/${tag}/mob_${version}_${os}_${arch}.tar.gz`;
	const sum = (os: string, arch: string) => sums[`mob_${version}_${os}_${arch}.tar.gz`] ?? '';
	const block = (os: 'darwin' | 'linux') => `    on_intel do
      url "${url(os, 'amd64')}"
      sha256 "${sum(os, 'amd64')}"
    end
    on_arm do
      url "${url(os, 'arm64')}"
      sha256 "${sum(os, 'arm64')}"
    end`;
	const cask = `cask "mob" do
  name "mob"
  desc "Local assistant with desktop, terminal and background service"
  homepage "https://usemob.app"
  version "${version.replace(/^v/, '')}"

  on_macos do
${block('darwin')}
  end

  on_linux do
${block('linux')}
  end

  binary "mob_${version}_#{OS.mac? ? "darwin" : "linux"}_#{Hardware::CPU.intel? ? "amd64" : "arm64"}/mob"

  # The binary is not notarized, so macOS would refuse to start it.
  postflight do
    if OS.mac?
      system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{staged_path}"]
    end
  end
end
`;
	await Bun.write(join(dist, 'mob.rb'), cask);
	const token = process.env.HOMEBREW_TAP_TOKEN;
	// Without a token the cask is written to dist/ but not published.
	if (token) {
		const tap = join(dist, 'homebrew-tap');
		await $`git clone -q --depth 1 https://x-access-token:${token}@github.com/fdkevin0/homebrew-tap.git ${tap}`;
		mkdirSync(join(tap, 'Casks'), { recursive: true });
		copyFileSync(join(dist, 'mob.rb'), join(tap, 'Casks', 'mob.rb'));
		await $`git add Casks/mob.rb && git -c user.name=mob-release -c user.email=noreply@usemob.app commit -qm ${'mob ' + version} && git push -q`.cwd(tap).nothrow();
		rmSync(tap, { recursive: true, force: true });
	}
}
