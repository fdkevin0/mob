import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.go; });

it('guides missing configuration, masks the key, retries and opens chat after saving', async () => {
  window.go = { main: { Desktop: { Connection: async () => ({ url: 'http://localhost', token: 'token' }) } } };
  let configured = false, attempts = 0;
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/config')) {
      if (options?.method === 'POST') {
        attempts++;
        expect(JSON.parse(options.body as string)).toEqual({ apiKey: 'test-key' });
        if (attempts === 1) return new Response('Could not save configuration. Try again.', { status: 500 });
        configured = true;
      }
      return Response.json({ configured, demo: false, model: 'test' });
    }
    if (url.endsWith('/conversations')) return Response.json([{ id: 'one', title: 'Existing' }]);
    return Response.json({ messages: [], active: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  const input = await screen.findByLabelText('API key');
  expect(input.getAttribute('type')).toBe('password');
  expect(fetchMock.mock.calls.every(([url]) => url.endsWith('/config'))).toBe(true);
  fireEvent.change(input, { target: { value: 'test-key' } });
  fireEvent.click(screen.getByText('Save and continue'));
  await screen.findByRole('alert');
  expect((input as HTMLInputElement).value).toBe('test-key');
  fireEvent.click(screen.getByText('Save and continue'));
  await screen.findByLabelText('Message');
  await waitFor(() => expect(screen.queryByLabelText('API key')).toBeNull());
});
