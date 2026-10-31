import { useEffect, useRef, useState } from 'react';
import { VoxelCanvas } from '../landing/voxel/VoxelCanvas';
import { project } from '../landing/voxel/project';
import { plan } from './plan';
import { rowZ, stations, studio, studioFrame, where, type Decision } from './studio';

const PIXEL = 2;
const scene = { decision: undefined as Decision };
const draw = (time: number) => studio(scene.decision, Date.now(), time);

// What a task is doing, in the words the card uses.
function status(i: number, decision: Decision, now: number) {
	if (!decision) return { label: 'Waiting for you', tone: 'wait' };
	if (!decision.approved) return { label: 'Not started', tone: 'off' };
	const { phase } = where(i, (now - decision.at) / 1000, decision.input);
	if (!phase) return { label: 'Starting', tone: 'off' };
	if (phase.stage === 'build') return phase.tries ? { label: 'Fixing what the checks found', tone: 'wait' } : { label: 'Building', tone: 'run' };
	if (phase.stage === 'verify') return { label: phase.passed === false ? 'Checks failed' : 'Checking', tone: phase.passed === false ? 'wait' : 'run' };
	if (phase.stage === 'review') return { label: 'In review', tone: 'run' };
	return { label: 'Ready to review', tone: 'ok' };
}

/**
 * PlanStudio shows the plan as the landing page's office of calves: one row
 * per task, and each calf doing what its task is doing. Each desk carries its
 * task's number, and the card under the studio says the same in words.
 */
export function PlanStudio({ decision }: { decision: Decision }) {
	scene.decision = decision;
	const box = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<[number, number]>([0, 0]);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const fit = () => setSize([el.clientWidth, el.clientHeight]);
		fit();
		const sized = new ResizeObserver(fit);
		sized.observe(el);
		return () => sized.disconnect();
	}, []);
	useEffect(() => {
		if (!decision?.approved) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [decision]);
	// Labels sit where the scene draws, in CSS pixels.
	const f = studioFrame(Math.ceil(size[0] / PIXEL), Math.ceil(size[1] / PIXEL));
	const at = (x: number, y: number, z: number) => {
		const [px, py] = project(x, y, z, f);
		return { left: px * PIXEL, top: py * PIXEL };
	};
	return (
		<div ref={box} className="plan-studio">
			<VoxelCanvas className="plan-studio-canvas" scene={draw} frame={studioFrame} gpu pixel={PIXEL} fps={20} still={2} label="The plan as a studio of calves: one row per task, from the agent's desk through the checks booth and the reviewer to your tray" />
			{size[0] > 0 && (
				<>
					{(['checks', 'review', 'tray'] as const).map((k) => (
						<span key={k} className="plan-studio-station" style={at(stations[k] + (k === 'review' ? 4 : 0), 12, rowZ(0) - 12)}>
							{{ checks: 'Checks', review: 'Review', tray: 'You' }[k]}
						</span>
					))}
					{plan.tasks!.map((task, i) => {
						const s = status(i, decision, now);
						return (
							<span key={i} className="plan-studio-row" data-tone={s.tone} style={at(stations.desk - 6, 3, rowZ(i) + 6)} title={`${task.title} · ${task.agent}: ${s.label}`}>
								{i + 1}
								<span className="sr-only">
									{task.title}: {s.label}
								</span>
							</span>
						);
					})}
				</>
			)}
		</div>
	);
}
