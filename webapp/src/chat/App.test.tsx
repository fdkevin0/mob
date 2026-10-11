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
