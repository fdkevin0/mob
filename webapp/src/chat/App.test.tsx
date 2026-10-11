import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.go; });

it('opens chat without key setup and shows the conversation model', async () => {
  window.go = { main: { Desktop: { Connection: async () => ({ url: 'http://localhost', token: 'token' }) } } };
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url.endsWith('/config')) return Response.json({ defaultModel: 'opencode/mimo-v2.6-flash-free', demo: false });
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false, model: 'deepseek/deepseek-chat' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await screen.findByLabelText('Message');
  await waitFor(() => expect(screen.getByText('deepseek/deepseek-chat')).toBeTruthy());
  expect(screen.queryByLabelText('API key')).toBeNull();
  expect(fetchMock.mock.calls.some(([, options]) => String(options?.body ?? '').includes('apiKey'))).toBe(false);
});

it('promises no model calls only when the conversation uses the demo model', async () => {
  window.go = { main: { Desktop: { Connection: async () => ({ url: 'http://localhost', token: 'token' }) } } };
  let model = 'demo/echo';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/runtime')) return Response.json({ background: false });
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false, model });
  }));
  render(<App />);
  await screen.findByText('Demo mode · no model calls');
  cleanup();
  model = 'deepseek/deepseek-chat';
  render(<App />);
  await screen.findByText('deepseek/deepseek-chat');
  expect(screen.queryByText('Demo mode · no model calls')).toBeNull();
});

it('shows why the desktop could not start instead of asking for a token', async () => {
  const reason = 'This database has schema 1, last opened by an unknown release. Install Mob 20261011.bbbbbbb from https://github.com/fdkevin0/mob/releases/tag/20261011.bbbbbbb, start it once to upgrade the database, then start Mob 20261101.ddddddd again.';
  window.go = { main: { Desktop: { Connection: async () => { throw reason; } } } };
  render(<App />);
  expect((await screen.findByRole('alert')).textContent).toBe(reason);
  expect(screen.getByText('Mob could not start.')).toBeTruthy();
  expect(screen.queryByLabelText('Local access token')).toBeNull();
});
