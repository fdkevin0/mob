import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState, type KeyboardEvent } from 'react';
import { lastToken, useCompletion } from './useCompletion';

const connection = { url: 'http://localhost', token: 'test' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function key(name: string) {
  const event = { key: name, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn() };
  return event as unknown as KeyboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

function setup() {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    const { text } = JSON.parse(String(options?.body));
    requests.push(text);
    if (text === '/mo') return Response.json([{ value: '/model', label: '/model [NAME]' }, { value: '/models', label: '/models [FILTER]' }]);
    if (text === '/model ') return Response.json([{ value: 'default', label: 'default' }, { value: 'demo/echo', label: 'demo/echo' }]);
    if (text === '/models') return Response.json([{ value: '/models', label: '/models [FILTER]' }]);
    if (text === '/') return Response.json([{ value: '/model', label: '/model [NAME]' }, { value: '/new', label: '/new' }, { value: '/compact', label: '/compact' }]);
    return Response.json([]);
  }));
  const hook = renderHook(() => {
    const [input, setInput] = useState('');
    return { input, setInput, ...useCompletion({ connection, id: 'one', input, setInput }) };
  });
  return { hook, requests };
}

it('splits off the token a suggestion replaces', () => {
  expect(lastToken('/model default de')).toEqual(['/model default ', 'de']);
  expect(lastToken('/model ')).toEqual(['/model ', '']);
});

it('completes a command and then its argument', async () => {
  const { hook: { result } } = setup();
  act(() => result.current.setInput('/mo'));
  await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
  act(() => { result.current.onKeyDown(key('ArrowDown')); });
  expect(result.current.selected).toBe(1);
  act(() => { result.current.onKeyDown(key('ArrowUp')); });
  const tab = key('Tab');
  act(() => { expect(result.current.onKeyDown(tab)).toBe(true); });
  expect(tab.preventDefault).toHaveBeenCalled();
  expect(result.current.input).toBe('/model ');
  await waitFor(() => expect(result.current.suggestions.map(s => s.value)).toEqual(['default', 'demo/echo']));
  // An empty token sends on Enter instead of picking a suggestion.
  act(() => { expect(result.current.onKeyDown(key('Enter'))).toBe(false); });
  act(() => { result.current.onKeyDown(key('Escape')); });
  expect(result.current.suggestions).toHaveLength(0);
});

it('sends a complete command on Enter and ignores free text', async () => {
  const { hook: { result }, requests } = setup();
  act(() => result.current.setInput('/models'));
  await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
  act(() => { expect(result.current.onKeyDown(key('Enter'))).toBe(false); });
  act(() => result.current.setInput('hello /mo'));
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(requests).not.toContain('hello /mo');
  expect(result.current.suggestions).toHaveLength(0);
});

it('does not apply suggestions computed for older text', async () => {
  const { hook: { result } } = setup();
  act(() => result.current.setInput('/mo'));
  await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
  // The user finishes typing before the answer for "/models" arrives.
  act(() => result.current.setInput('/models'));
  act(() => { expect(result.current.onKeyDown(key('Enter'))).toBe(false); });
  act(() => { result.current.onKeyDown(key('Tab')); });
  expect(result.current.input).toBe('/models');
});

it('leaves commands the workspace has buttons for out of the bare / list, but completes them when typed', async () => {
  const { hook: { result } } = setup();
  act(() => result.current.setInput('/'));
  await waitFor(() => expect(result.current.suggestions.map(s => s.value)).toEqual(['/compact']));
  act(() => result.current.setInput('/mo'));
  await waitFor(() => expect(result.current.suggestions.map(s => s.value)).toEqual(['/model', '/models']));
});
