// Writes docs/environment-variables.md from the options in src/config.ts.
import { resolve } from 'node:path';
import { reference } from '../src/config';

await Bun.write(resolve(import.meta.dir, '../../../docs/environment-variables.md'), reference());
