// Builds the site Workers Builds deploys (the root wrangler.jsonc): this package's
// pages with /app from @mob/app, then the documentation (@mob/docs) under /docs.
import { $ } from 'bun';
import { cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const docs = dirname(Bun.resolveSync('@mob/docs/package.json', root));
await $`bun x vite build`.cwd(root);
await $`bun run build`.cwd(docs);
await cp(resolve(docs, 'dist'), resolve(root, 'dist/docs'), { recursive: true });
