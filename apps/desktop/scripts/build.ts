// Bundles the main process and the preload script. The preload runs in a
// sandboxed renderer, so it must be one CommonJS file.
const result = await Bun.build({
	entrypoints: [`${import.meta.dir}/../src/main.ts`, `${import.meta.dir}/../src/preload.ts`],
	outdir: `${import.meta.dir}/../dist`,
	target: 'node',
	format: 'cjs',
	external: ['electron'],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
