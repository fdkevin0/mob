// Publishes the npm packages that `bun scripts/release.ts --npm` wrote to
// dist/npm (docs/features/releases.md). Without NPM_TOKEN it only lists them.
import { $ } from 'bun';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(import.meta.dir, '../../dist/npm');
const { version, tag, packages } = await Bun.file(join(out, 'publish.json')).json() as { version: string; tag: string; packages: string[] };
const token = process.env.NPM_TOKEN;
if (!token) {
	console.log(`NPM_TOKEN is not set; not publishing ${packages.join(', ')} ${version}`);
	process.exit(0);
}
const npmrc = join(out, '.npmrc');
await Bun.write(npmrc, `//registry.npmjs.org/:_authToken=${token}\n`);
const env = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
try {
	for (const name of packages) {
		// A rerun of the workflow skips what an earlier run already published.
		const published = await $`npm view ${name}@${version} version`.env(env).quiet().nothrow();
		if (published.exitCode === 0 && published.stdout.toString().trim() === version) {
			console.log(`${name}@${version} is already published`);
			continue;
		}
		await $`npm publish --access public --provenance --tag ${tag}`.cwd(join(out, name)).env(env);
	}
} finally {
	rmSync(npmrc, { force: true });
}
