import { expect, it } from 'vitest';
import { done, nodes, phases, stagesOf } from './plan';

const where = (seconds: number, changed?: unknown) => nodes(seconds, changed).map((n) => `${n.status}/${n.task?.flow?.stage}`);

it('moves each task through its blueprint, and the checkout field back once', () => {
	expect(where(0)).toEqual(['running/build', 'running/build', 'running/build']);
	expect(phases(1, stagesOf(1)).map(([, p]) => p.stage)).toEqual(['build', 'verify', 'build', 'verify', 'review', 'ready']);
	expect(nodes(9)[1].task?.flow?.tries).toBe(1);
	expect(where(done())).toEqual(['review/ready', 'review/ready', 'review/ready']);
});

it('runs the stages the owner approved', () => {
	const changed = { tasks: [{}, {}, { stages: [{ type: 'verify', retries: 0 }, { type: 'review', aspects: ['docs'], rounds: 1 }] }] };
	expect(phases(2, stagesOf(2, changed)).map(([, p]) => p.stage)).toEqual(['build', 'verify', 'review', 'ready']);
	expect(nodes(0, changed)[2].task?.flow?.stages).toEqual(changed.tasks[2].stages);
	// No retries: the checkout field's checks pass the first time.
	expect(phases(1, [{ type: 'verify', retries: 0 }]).map(([, p]) => p.stage)).toEqual(['build', 'verify', 'ready']);
});
