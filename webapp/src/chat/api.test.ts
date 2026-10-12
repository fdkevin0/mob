import { expect, it } from 'vitest';
import { readOffer, timeoutFor } from './api';

it('gives command execution the plugin timeout and keeps completion short', () => {
  expect(timeoutFor('/commands/run')).toBe(60_000);
  expect(timeoutFor('/plugins/email/analyze')).toBe(60_000);
  expect(timeoutFor('/commands/complete')).toBe(10_000);
  expect(timeoutFor('/conversations')).toBe(10_000);
});

it('reads only offers for Mob on this computer', () => {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  expect(readOffer(encode({ v: 1, url: 'http://127.0.0.1:8787', code: 'c' }))).toEqual({ url: 'http://127.0.0.1:8787', code: 'c' });
  expect(readOffer(encode({ v: 1, url: 'http://localhost:8787', code: 'c' }))).toEqual({ url: 'http://localhost:8787', code: 'c' });
  for (const url of ['https://127.0.0.1:8787', 'http://192.168.1.2:8787', 'http://127.0.0.1.evil.example', 'http://user@127.0.0.1:8787', 'http://127.0.0.1:8787/api'])
    expect(() => readOffer(encode({ v: 1, url, code: 'c' }))).toThrow('another computer');
  expect(() => readOffer(encode({ v: 2, url: 'http://127.0.0.1:8787', code: 'c' }))).toThrow('does not understand');
  expect(() => readOffer(encode({ v: 1, url: 'http://127.0.0.1:8787', code: '' }))).toThrow('does not understand');
  expect(() => readOffer('%%%')).toThrow('damaged');
});
