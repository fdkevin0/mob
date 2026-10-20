import { expect, it } from 'vitest';
import { calfHead } from '@/components/brand/calfHead';

it('draws the logo mirror-symmetric left to right', () => {
  for (const row of calfHead) expect(row).toBe([...row].reverse().join(''));
});
