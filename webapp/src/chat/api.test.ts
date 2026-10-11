import { expect, it } from 'vitest';
import { timeoutFor } from './api';

it('gives command execution the plugin timeout and keeps completion short', () => {
  expect(timeoutFor('/commands/run')).toBe(60_000);
  expect(timeoutFor('/plugins/email/analyze')).toBe(60_000);
  expect(timeoutFor('/commands/complete')).toBe(10_000);
  expect(timeoutFor('/conversations')).toBe(10_000);
});
