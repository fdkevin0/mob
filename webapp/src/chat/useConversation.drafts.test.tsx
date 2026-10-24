import 'fake-indexeddb/auto';
import { useLayoutEffect, type FormEvent } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as cache from './localCache';
import { useConversation } from './useConversation';

const connection = { url: 'http://draft-test', token: 'test' };
const scope = cache.cacheScope(connection);
const initial = { messages: [], active: false, model: 'demo/echo' };
const options = { connection, id: 'one', initial, onChanged: () => {} };

beforeEach(async () => {
	cache.resume(scope);
	await cache.setKeepsMessages(true);
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(initial)));
});
afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await cache.setKeepsMessages(false);
	await cache.forget(scope);
});

it('restores a draft after remount and does not bring back a cleared draft', async () => {
	const first = renderHook(() => useConversation(options));
	act(() => first.result.current.setInput('中文草稿'));
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBe('中文草稿'));
	first.unmount();
	const second = renderHook(() => useConversation(options));
	await waitFor(() => expect(second.result.current.input).toBe('中文草稿'));
	act(() => second.result.current.setInput(''));
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBeUndefined());
	second.unmount();
	const third = renderHook(() => useConversation(options));
	expect(third.result.current.input).toBe('');
});

it.each(['New draft', ''])('does not overwrite a newer edit with a delayed saved draft: %s', async (newer) => {
	let resolve!: (value: string) => void;
	vi.spyOn(cache, 'readDraft').mockReturnValue(new Promise<string>(done => { resolve = done; }));
	const { result } = renderHook(() => useConversation(options));
	act(() => { result.current.setInput('Editing'); result.current.setInput(newer); });
	await act(async () => resolve('Old saved draft'));
	expect(result.current.input).toBe(newer);
});

it('prefers an in-memory cleared draft over a saved draft', async () => {
	await cache.writeDraft(scope, 'one', 'Old saved draft');
	const { result } = renderHook(() => useConversation({ ...options, initialInput: '' }));
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBeUndefined());
	expect(result.current.input).toBe('');
});

it('does not restore a delayed draft into a conversation that has closed', async () => {
	let resolve!: (value: string) => void;
	vi.spyOn(cache, 'readDraft').mockReturnValue(new Promise<string>(done => { resolve = done; }));
	const { result, unmount } = renderHook(() => useConversation(options));
	unmount();
	await act(async () => resolve('Old saved draft'));
	expect(result.current.input).toBe('');
});


it('removes the saved draft on send and saves newer input separately', async () => {
	vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/chat')
		? new Promise<Response>(() => {}) : Promise.resolve(Response.json(initial))));
	const { result } = renderHook(() => useConversation(options));
	act(() => result.current.setInput('Send this'));
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBe('Send this'));
	act(() => result.current.submit({ preventDefault() {} } as FormEvent));
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBeUndefined());
	act(() => result.current.setInput('Next draft'));
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBe('Next draft'));
});


it('keeps a saved draft when leaving before restoration completes', async () => {
	await cache.writeDraft(scope, 'one', 'Saved draft');
	let resolve!: (value: string) => void;
	vi.spyOn(cache, 'readDraft').mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
	let handedOff: string | undefined;
	const first = renderHook(() => useConversation({ ...options, onLeave: (_, input) => { handedOff = input; } }));
	first.unmount();
	expect(handedOff).toBeUndefined();
	await act(async () => resolve('Saved draft'));
	const second = renderHook(() => useConversation({ ...options, initialInput: handedOff }));
	await waitFor(() => expect(second.result.current.input).toBe('Saved draft'));
	expect(await cache.readDraft(scope, 'one')).toBe('Saved draft');
});

it('saves an existing draft when retention is enabled without another edit', async () => {
	await cache.setKeepsMessages(false);
	const { result, rerender } = renderHook(({ keeping }) => useConversation({ ...options, keeping }), { initialProps: { keeping: false } });
	act(() => result.current.setInput('Existing draft'));
	expect(await cache.readDraft(scope, 'one')).toBeUndefined();
	await act(async () => { await cache.setKeepsMessages(true); });
	rerender({ keeping: true });
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBe('Existing draft'));
});

it('does not clear an unread saved draft when retention is enabled', async () => {
	await cache.writeDraft(scope, 'one', 'Saved draft');
	let resolve!: (value: string) => void;
	vi.spyOn(cache, 'readDraft').mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
	const { result, rerender } = renderHook(({ keeping }) => useConversation({ ...options, keeping }), { initialProps: { keeping: false } });
	rerender({ keeping: true });
	expect(await cache.readDraft(scope, 'one')).toBe('Saved draft');
	await act(async () => resolve('Saved draft'));
	expect(result.current.input).toBe('Saved draft');
});


it('keeps input entered before the draft subscription starts', async () => {
	let handedOff: string | undefined;
	const { unmount } = renderHook(() => {
		const conversation = useConversation({ ...options, onLeave: (_, input) => { handedOff = input; } });
		useLayoutEffect(() => conversation.setInput('Early input'), []);
		return conversation;
	});
	await waitFor(async () => expect(await cache.readDraft(scope, 'one')).toBe('Early input'));
	unmount();
	expect(handedOff).toBe('Early input');
});
