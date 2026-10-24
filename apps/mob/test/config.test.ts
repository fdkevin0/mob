import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reference } from '../src/config';

test('the environment reference is current', () => {
	// Regenerate with bun run --cwd apps/mob configdocs.
	expect(readFileSync(join(import.meta.dir, '../../../docs/environment-variables.md'), 'utf8')).toBe(reference());
});
