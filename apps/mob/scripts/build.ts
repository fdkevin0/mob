// Compiles mob into one executable with the web UI embedded:
// bun scripts/build.ts [--outfile PATH] [--target bun-linux-x64] [--version V]
import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { outfile: { type: 'string' }, target: { type: 'string' }, version: { type: 'string' } } });
const root = resolve(import.meta.dir, '../../..');
const dist = resolve(root, 'webapp/dist');
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('webapp/dist is empty; run bun run build first');
const assets = [...new Glob('**/*').scanSync({ cwd: dist, onlyFiles: true })].filter(f => f !== '.gitkeep');
// Each file is imported as a file, which a compiled executable embeds as it is.
const web = assets.map((f, i) => `import f${i} from ${JSON.stringify(resolve(dist, f))} with { type: 'file' };`).join('\n') +
	`\nexport const files: Record<string, string> = {${assets.map((f, i) => `${JSON.stringify('/' + f.replaceAll('\\', '/'))}: f${i}`).join(', ')}};\n`;
const outfile = resolve(values.outfile ?? resolve(root, 'build', process.platform === 'win32' ? 'mob.exe' : 'mob'));
const result = await Bun.build({
	entrypoints: [resolve(import.meta.dir, '../src/main.ts')],
	plugins: [{ name: 'web', setup(b) {
		b.onLoad({ filter: /apps[\\/]mob[\\/]src[\\/]web\.ts$/ }, () => ({ contents: web, loader: 'ts' }));
	} }],
	compile: { outfile, ...(values.target ? { target: values.target as Bun.Build.Target } : {}) },
	define: { 'process.env.MOB_BUILD_VERSION': JSON.stringify(values.version ?? process.env.MOB_BUILD_VERSION ?? 'dev') },
	minify: true,
	sourcemap: 'linked',
	root,
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log('Built ' + outfile);
