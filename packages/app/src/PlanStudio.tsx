import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VoxelCanvas } from '@mob/ui/voxel/VoxelCanvas';
import { project } from '@mob/ui/voxel/project';
import { rowZ, stations, studioFrame, studioVoxels, type Place, type StudioRow } from './studioScene';

const PIXEL = 2;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export type StudioTask = { title: string; checks: boolean; review: boolean; place?: Place; fixing?: boolean; status: string; tone: 'run' | 'wait' | 'ok' | 'idle' };

/**
 * PlanStudio draws a plan as a studio of calves: one row per task, each calf
 * doing what its task is doing, and walking between stations as the task
 * moves on. Each desk carries its task's number, ringed in its status colour;
 * the number says the status in words to assistive technology and on hover,
 * and opens the task's steps in the flow.
 */
export function PlanStudio({ tasks, waiting, select }: { tasks: StudioTask[]; waiting: boolean; select: (index: number) => void }) {
	// When each task got where it is, and from where, so a move is walked.
	const seen = useRef<{ place?: Place; fixing?: boolean; from?: Place; at: number }[]>([]);
	tasks.forEach((task, i) => {
		const was = seen.current[i];
		if (!was) seen.current[i] = { place: task.place, fixing: task.fixing, at: -Infinity };
		else if (was.place !== task.place || was.fixing !== task.fixing) seen.current[i] = { place: task.place, fixing: task.fixing, from: was.place, at: Date.now() };
	});
	const latest = useRef({ tasks, waiting });
	latest.current = { tasks, waiting };
	const scene = useCallback((time: number) => {
		const now = Date.now();
		// With motion reduced the canvas is still, so each calf is drawn where
		// its task is now, never halfway through a walk.
		const settled = reducedMotion();
		const rows: StudioRow[] = latest.current.tasks.map((task, i) => {
			const s = seen.current[i];
			return { checks: task.checks, review: task.review, place: task.place, fixing: task.fixing, from: s?.from, since: s && !settled ? (now - s.at) / 1000 : Infinity };
		});
		return studioVoxels({ rows, waiting: latest.current.waiting }, time);
	}, []);
	const frame = useMemo(() => studioFrame(tasks.length), [tasks.length]);
	const box = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<[number, number]>([0, 0]);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const fit = () => setSize([el.clientWidth, el.clientHeight]);
		fit();
		const sized = new ResizeObserver(fit);
		sized.observe(el);
		return () => sized.disconnect();
	}, []);
	const f = frame(Math.ceil(size[0] / PIXEL), Math.ceil(size[1] / PIXEL));
	// Labels sit where the scene draws, in CSS pixels.
	const at = (x: number, y: number, z: number) => {
		const [px, py] = project(x, y, z, f);
		return { left: px * PIXEL, top: py * PIXEL };
	};
	const stationsShown = { checks: tasks.some((t) => t.checks), review: tasks.some((t) => t.review) };
	return (
		<div ref={box} className="plan-studio">
			<VoxelCanvas
				className="plan-studio-canvas"
				scene={scene}
				frame={frame}
				gpu
				pixel={PIXEL}
				fps={20}
				still={2}
				redraw={`${waiting} ${tasks.map((t) => `${t.place}:${t.fixing ? 1 : 0}`).join(' ')}`}
				label="The plan as a studio of calves: one row per task, from the agent's desk through the checks booth and the reviewer to your tray"
			/>
					{(['checks', 'review', 'tray'] as const)
						.filter((k) => k === 'tray' || stationsShown[k])
						.map((k) => (
							<span key={k} className="plan-studio-station" style={at(stations[k] + (k === 'review' ? 4 : 0), 12, rowZ(0) - 12)}>
								{{ checks: 'Checks', review: 'Review', tray: 'You' }[k]}
							</span>
						))}
					{tasks.map((task, i) => (
						<button
							key={i}
							type="button"
							className="plan-studio-task"
							data-tone={task.tone}
							style={at(stations.desk - 6, 3, rowZ(i) + 6)}
							title={`${task.title}: ${task.status}`}
							aria-label={`${i + 1}. ${task.title}: ${task.status}. Show its steps`}
							onClick={() => select(i)}
						>
							{i + 1}
						</button>
					))}
		</div>
	);
}
