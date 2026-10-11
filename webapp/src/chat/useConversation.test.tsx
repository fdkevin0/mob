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
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
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
  const { result, unmount } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => { void result.current.decide('approval', true); });
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
});
it('runs slash commands through the service and sends the rest as chat', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url.endsWith('/commands/run')) {
      if (body.text === '/list') return Promise.resolve(Response.json({ handled: true, markdown: '| Conversation |' }));
      if (body.text === '/open two') return Promise.resolve(Response.json({ handled: true, action: { kind: 'open-conversation', conversationId: 'two' } }));
      if (body.text === '/approve') return Promise.resolve(Response.json({ handled: true, action: { kind: 'decide', approvalId: 'a1', approved: true } }));
      if (body.text === '/broken') return Promise.resolve(new Response('email plugin is disabled', { status: 409 }));
      return Promise.resolve(Response.json({ handled: false }));
    }
    if (url.endsWith('/chat')) { chats.push(JSON.stringify(body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const onAction = vi.fn();
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {}, onAction }));
  const submit = async (text: string) => {
    act(() => result.current.setInput(text));
    act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  };
  await submit('/list');
  await waitFor(() => expect(result.current.commandResult).toBe('| Conversation |'));
  expect(chats).toHaveLength(0);
  await submit('/open two');
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ kind: 'open-conversation', conversationId: 'two' }));
  expect(result.current.commandResult).toBeUndefined();
  await submit('/broken');
  await waitFor(() => expect(result.current.failure).toBe('email plugin is disabled'));
  expect(result.current.input).toBe('/broken');
  await submit('/approve');
  await waitFor(() => expect(chats.some(c => c.includes('"approval":{"id":"a1","approved":true}'))).toBe(true));
});
it('sends a slash command the service does not run as chat', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/commands/run')) return Promise.resolve(Response.json({ handled: false }));
    if (url.endsWith('/chat')) { chats.push(String(options?.body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => result.current.setInput('/models'));
  act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  await waitFor(() => expect(chats.some(c => c.includes('"text":"/models"'))).toBe(true));
});
it('sends the reason a /deny gives with the denial', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/commands/run')) return Promise.resolve(Response.json({ handled: true, action: { kind: 'decide', approvalId: 'a1', approved: false, reason: 'too long' } }));
    if (url.endsWith('/chat')) { chats.push(String(options?.body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => result.current.setInput('/deny too long'));
  act(() => result.current.submit({ preventDefault() {} } as FormEvent));
  await waitFor(() => expect(chats.some(c => c.includes('"approval":{"id":"a1","approved":false,"reason":"too long"}'))).toBe(true));
});
it('asks the service to remember an approval', async () => {
  const chats: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/chat')) { chats.push(String(options?.body)); return new Promise<Response>(() => {}); }
    return Promise.resolve(Response.json({ messages: [], active: false, model: 'demo/echo' }));
  }));
  const { result } = renderHook(() => useConversation({ connection, id: 'one', initial: { messages: [], active: false, model: 'demo/echo' }, onBusy: () => {}, onChanged: () => {} }));
  act(() => { void result.current.decide('a1', true, undefined, 'always'); });
  await waitFor(() => expect(chats.some(c => c.includes('"approval":{"id":"a1","approved":true,"remember":"always"}'))).toBe(true));
});
