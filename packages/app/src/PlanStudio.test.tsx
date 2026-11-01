import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlanStudio, type StudioTask } from './PlanStudio';
import { studioVoxels } from './studioScene';

vi.mock('./studioScene', async (actual) => ({ ...(await actual<typeof import('./studioScene')>()), studioVoxels: vi.fn(() => []) }));

beforeEach(() => {
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
	vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {} } as never);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const task = (place: StudioTask['place']): StudioTask => ({ title: 'Parse', checks: true, review: true, place, status: place ?? 'idle', tone: 'run' });

it('draws a task that moved on while motion is reduced, where it is now and not mid-walk', async () => {
	const view = render(<PlanStudio tasks={[task('build')]} waiting={false} select={() => {}} />);
	await act(async () => {});
	const drawn = vi.mocked(studioVoxels);
	expect(drawn.mock.lastCall?.[0].rows[0].place).toBe('build');
	// Reduced motion draws one still frame, so the move has to ask for another.
	expect(drawn.mock.lastCall?.[1]).toBe(2);

	view.rerender(<PlanStudio tasks={[task('verify')]} waiting={false} select={() => {}} />);
	await act(async () => {});
	expect(drawn.mock.lastCall?.[0].rows[0]).toMatchObject({ place: 'verify', from: 'build', since: Infinity });
	view.unmount();
});
