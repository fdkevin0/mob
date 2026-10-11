import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';
import { useConversation } from './useConversation';

const connection = { url: 'http://localhost', token: 'test' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('ignores a stale history response after a local send and restores input on failure', async () => {
  let resolveHistory!: (value: Response) => void;
  let rejectSend!: (error: Error) => void;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/chat')) return new Promise<Response>((_, reject) => { rejectSend = reject; });
    if (++reads === 1) return new Promise<Response>(resolve => { resolveHistory = resolve; });
    return Promise.resolve(Response.json({ messages: [], active: false }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false }, onBusy: () => {}, onChanged: () => {} }));
  act(() => result.current.setInput('keep my text'));
  act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  await waitFor(() => expect(result.current.busy).toBe(true));
  await act(async () => resolveHistory(Response.json({ messages: [{ id: 'stale', role: 'assistant', parts: [{ type: 'text', text: 'stale history' }] }], active: false })));
  expect(result.current.messages.some(m => m.id === 'stale')).toBe(false);
  await act(async () => rejectSend(new Error('connection failed')));
  await waitFor(() => expect(result.current.input).toBe('keep my text'));
});
it('cancels an approval stream when the conversation is unmounted', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/chat')) {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }
    return Promise.resolve(Response.json({ messages: [], active: false }));
  }));
  const { result, unmount } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false }, onBusy: () => {}, onChanged: () => {} }));
  act(() => { void result.current.decide('approval', true); });
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
});
