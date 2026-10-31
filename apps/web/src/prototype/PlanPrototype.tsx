import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { PlanCard } from '@mob/app/PlanCard';
import { CheckIcon, CrossIcon, HandIcon } from '@mob/app/icons';
import { Button } from '@mob/ui/button';
import { approved, done, nodes, output, plan } from './plan';
import { PlanStudio } from './PlanStudio';
import type { Decision } from './studio';


// The page talks to no Mob: what the card asks for, /tasks, is the sample's.
let tasks: () => unknown = () => [];
if (typeof window !== 'undefined') window.fetch = async () => Response.json(tasks());

// The flow fills the frame while it is open; the card alone is as tall as it is.
const flowHeight = 840;

/**
 * PlanPrototype is the plan card working on sample data, for the documentation
 * to embed (docs/features/plans.md): the owner can open the flow, change the
 * plan and approve it, then watch the tasks move. Nothing reaches a Mob; the
 * replies Mob would send come from plan.ts.
 *
 * ?flow=1.verify opens the flow on a step, ?started=7 starts as if the plan
 * was approved 7 seconds ago, and ?view=studio shows the plan above the card as
 * a studio of calves.
 */
export function PlanPrototype({ search }: { search: string }) {
	const query = new URLSearchParams(search);
	const startedAgo = Number(query.get('started'));
	const [decision, setDecision] = useState<Decision>(() => (query.has('started') ? { approved: true, at: Date.now() - startedAgo * 1000 } : undefined));
	const [run, setRun] = useState(0);
	const root = useRef<HTMLDivElement>(null);
	useFrameHeight(root);

	// The workspace reads started tasks from Mob's /tasks, and again whenever Mob says something changed.
	const changes = useMemo(() => {
		const listeners = new Set<() => void>();
		return { live: true, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)), notify: () => listeners.forEach((l) => l()) };
	}, []);
	// Set during render, so the card's first read of /tasks already gets it.
	tasks = () => (decision?.approved ? nodes((Date.now() - decision.at) / 1000, decision.input) : []);
	useEffect(() => {
		if (!decision?.approved) return;
		const end = done(decision.input) * 1000 + 1000;
		const timer = setInterval(() => {
			changes.notify();
			if (Date.now() - decision.at > end) clearInterval(timer);
		}, 1000);
		return () => clearInterval(timer);
	}, [decision, changes]);

	const state = !decision
		? { kind: 'waiting', label: 'Waiting for your approval', icon: <HandIcon /> }
		: decision.approved
			? { kind: 'done', label: 'Done', icon: <CheckIcon /> }
			: { kind: 'failed', label: 'Denied', icon: <CrossIcon /> };
	return (
		<div ref={root} className="prototype">
			{query.get('view') === 'studio' && <PlanStudio decision={decision} />}
			<PlanCard
				key={run}
				connection={{ url: '', token: '' }}
				changes={changes as unknown as ComponentProps<typeof PlanCard>['changes']}
				input={decision?.approved ? approved(decision.input) : plan}
				output={decision?.approved ? output : undefined}
				state={state}
				open={() => {}}
				defaultFlow={query.get('flow') ?? undefined}
				approval={decision ? undefined : { busy: false, decide: (approved, _reason, _remember, input) => setDecision({ approved, at: Date.now(), input }) }}
			>
				{decision && !decision.approved && <p className="plan-failed">You denied the plan, so nothing started.</p>}
			</PlanCard>
			<p className="prototype-foot">
				<span>Prototype with sample data: nothing runs.</span>
				{decision && (
					<Button
						variant="ghost"
						onClick={() => {
							setDecision(undefined);
							setRun((n) => n + 1);
						}}
					>
						Start over
					</Button>
				)}
			</p>
		</div>
	);
}

// useFrameHeight sizes the frame the docs embed this page in to what it shows,
// so the page around it never scrolls inside it.
function useFrameHeight(root: RefObject<HTMLDivElement | null>) {
	useLayoutEffect(() => {
		const frame = window.frameElement as HTMLIFrameElement | null;
		const el = root.current;
		if (!frame || !el) return;
		const fit = () => {
			const open = !!document.querySelector('.plan-flow-dialog');
			frame.style.height = `${open ? Math.max(flowHeight, el.offsetHeight) : el.offsetHeight}px`;
		};
		fit();
		const sized = new ResizeObserver(fit);
		sized.observe(el);
		const opened = new MutationObserver(fit);
		opened.observe(document.body, { childList: true });
		return () => {
			sized.disconnect();
			opened.disconnect();
		};
	}, [root]);
}
