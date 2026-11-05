// Publishes the npm packages that `bun scripts/release.ts --npm` wrote to
// dist/npm (docs/features/releases.md), platform packages first.
//
//   bun scripts/npm/publish.ts [--dir dist/npm]
//
// In GitHub Actions npm signs in with trusted publishing (OIDC) for packages
// that name this workflow as their publisher; NPM_TOKEN, when set, covers the
// rest. Without either it only lists the packages.
import { $ } from 'bun';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { dir: { type: 'string' } } });
const out = resolve(values.dir ?? resolve(import.meta.dir, '../../dist/npm'));
const { version, tag, packages } = await Bun.file(join(out, 'publish.json')).json() as { version: string; tag: string; packages: string[] };
const token = process.env.NPM_TOKEN;
const oidc = !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
if (!token && !oidc) {
	console.log(`Neither NPM_TOKEN nor a GitHub Actions OIDC token is available; not publishing ${packages.join(', ')} ${version}`);
	process.exit(0);
}
const npmrc = join(out, '.npmrc');
await Bun.write(npmrc, token ? `//registry.npmjs.org/:_authToken=${token}\n` : '');
const env = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
try {
	for (const name of packages) {
		// A rerun of the workflow skips what an earlier run already published.
		const published = await $`npm view ${name}@${version} version`.env(env).quiet().nothrow();
		if (published.exitCode === 0 && published.stdout.toString().trim() === version) {
			console.log(`${name}@${version} is already published`);
			continue;
		}
		const result = await $`npm publish --access public --provenance --tag ${tag}`.cwd(join(out, name)).env(env).nothrow();
		if (result.exitCode !== 0) {
			// Once a package has a trusted publisher, npm signs in with it instead of
			// NPM_TOKEN, and a publisher that allows only `npm stage publish` (npm's
			// default) refuses the publish.
			if (result.stderr.toString().includes('OIDC permission denied')) {
				console.error(`::error::npm refused to publish ${name}: its trusted publisher on npmjs.com does not allow \`npm publish\`. Open https://www.npmjs.com/package/${name}/access, edit the trusted publisher and tick \`npm publish\` (and "Allow npm dist-tag") under Allowed actions, then rerun this workflow.`);
			}
			throw new Error(`npm publish ${name}@${version} failed with exit code ${result.exitCode}`);
		}
	}
	// npm made the first nightly `latest`. Until a stable release takes the tag,
	// keep it on the newest nightly so `npm install -g usemob` is not stuck on it.
	// A rerun of an older nightly leaves a newer one in place.
	const main = packages.at(-1)!;
	if (tag === 'nightly') {
		const latest = (await $`npm view ${main} dist-tags.latest`.env(env).quiet().nothrow()).stdout.toString().trim();
		// Trusted publishing covers only publish, so this needs NPM_TOKEN.
		if (latest.includes('-nightly.') && Bun.semver.order(version, latest) === 1) {
			const moved = await $`npm dist-tag add ${main}@${version} latest`.env(env).nothrow();
			if (moved.exitCode !== 0) console.warn(`Could not move ${main}'s latest tag to ${version}`);
		}
	}
} finally {
	rmSync(npmrc, { force: true });
}
