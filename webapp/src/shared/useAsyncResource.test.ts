import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAsyncResource } from './useAsyncResource';

afterEach(cleanup);

it('ignores an older response after a newer reload has completed', async () => {
	let resolveOld!: (value: string) => void;
	const load = vi.fn().mockReturnValueOnce(new Promise<string>((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce('new');
	const { result } = renderHook(() => useAsyncResource(load, 'Could not load'));
	await act(() => result.current.reload());
	expect(result.current.data).toBe('new');
	await act(async () => { resolveOld('old'); });
	await waitFor(() => expect(result.current.loading).toBe(false));
	expect(result.current.data).toBe('new');
});
