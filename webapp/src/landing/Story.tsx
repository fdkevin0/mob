import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { PixelIcon } from '../components/brand/PixelIcon';
import type { IconName } from '../components/brand/pixels';
import { magnet } from './snap';
import { VoxelCanvas } from './voxel/VoxelCanvas';
import { calfAt, officeFrame, officeVoxels, setFade, setHighlight, setStory, type Activity } from './voxel/office';

// The top of the landing page is one pinned stage over the calves' office,
// scrolled through in pages: the title, a task played out step by step, then
// the features, with the office moved aside. Positions along the way are in
// viewport heights from the top of the story.
const WORKFLOW = 1; // the first step
const STEP = 0.6;
const FEATURES = 4.2; // the first feature
const FEATURE = 0.5;
const LENGTH = FEATURES + 5 * FEATURE + 0.6;

const steps = [
	{ title: 'You ask', text: 'From the web, the terminal, Telegram or email. The leader takes it in.' },
	{ title: 'The calves get to work', text: 'Mob plans the task and calls tools to search, read and run things.' },
	{ title: 'It asks first', text: 'Anything that changes your files or sends something waits for your nod.' },
	{ title: 'You get the answer', text: 'Only the conclusion comes back, wherever you asked.' },
];

export const features: { title: string; text: string; look: string; icon: IconName; doing: Activity[] }[] = [
	{ title: 'Runs at home', text: 'Mob runs on your computer with your own model keys, and keeps conversations in a local database.', look: 'calves typing at their desks', icon: 'terminal', doing: ['work', 'back'] },
	{ title: 'Every channel', text: 'Talk to the same assistant from the web, the desktop app, the terminal, Telegram or email.', look: 'calves carrying blocks of work', icon: 'channels', doing: ['deliver'] },
	{ title: 'Asks first', text: 'Tools with side effects wait for your approval, and you can remember a grant for next time.', look: 'hands up, and the gold leader', icon: 'shield', doing: ['ask', 'lead'] },
	{ title: 'Sandboxed', text: 'Commands run in a container, with optional network, CPU and memory limits.', look: 'the glass booth at the front', icon: 'box', doing: ['sandbox'] },
	{ title: 'Remembers', text: 'Every conversation stays on your machine, so you can pick it up again from any client.', look: 'notes going up on the whiteboard', icon: 'memory', doing: ['memo'] },
	{ title: 'Plugs in', text: 'MCP servers, Agent Skills and plugins add tools without changing Mob.', look: 'the milk tea bar and coffee machine', icon: 'spark', doing: ['drink'] },
];

const doing: Record<Activity, string> = {
	work: 'Working at its desk',
	back: 'Heading back to its desk',
	deliver: 'Passing work to a colleague',
	ask: 'Waiting for a nod',
	lead: 'The leader',
	sandbox: 'Trying something in the glass booth',
	memo: 'Pinning a note on the board',
	drink: 'Getting a drink',
	nap: 'Napping. The leader will be along',
	'high-five': 'High-fiving a colleague',
};

export const featureFor = (a: Activity) => {
	const i = features.findIndex(f => f.doing.includes(a));
	return i < 0 ? undefined : i;
};

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ramp = (p: number, from: number, to: number) => clamp((p - from) / (to - from));

function Chat({ step }: { step: number }) {
	const shown = (n: number, item: ReactNode) => step >= n ? <div className={`chat-item${step === n ? ' fresh' : ''}`}>{item}</div> : null;
	return (
		<div className="chat" aria-label="A conversation with Mob">
			<div className="chat-bar"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>Mob<span className="chat-channel">via Telegram</span></div>
			<div className="chat-body">
				{shown(0, <p className="bubble you">Find last month's invoices in my email and put the totals in a sheet.</p>)}
				{shown(1, <ul className="tools"><li><b>Searched email</b> 4 invoices</li><li><b>Read attachments</b> 4 PDFs</li></ul>)}
				{shown(2, (
					<div className="approve">
						<p><b>Write a file?</b><code>~/Documents/invoices-october.csv</code></p>
						<div className="approve-actions"><span className="approve-deny">Deny</span><span className="approve-allow">Allow</span></div>
					</div>
				))}
				{shown(3, <p className="bubble mob">Filed 4 October invoices, €1,284.50 in total, in <code>invoices-october.csv</code>.</p>)}
			</div>
		</div>
	);
}

export function Story({ hero }: { hero: ReactNode }) {
	const story = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLDivElement>(null);
	const title = useRef<HTMLDivElement>(null);
	const flow = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [step, setStep] = useState(-1);
	const [feature, setFeature] = useState(-1);
	const [tip, setTip] = useState<{ x: number; y: number; text: string }>();
	const [still] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

	// Scrolling moves the pieces directly; only the step and feature re-render.
	useEffect(() => {
		if (still) return;
		let raf = 0;
		const apply = () => {
			raf = 0;
			const top = story.current?.offsetTop ?? 0;
			const p = Math.max(0, (window.scrollY - top) / window.innerHeight);
			const narrow = window.innerWidth <= 760;
			const out = ramp(p, 0, 0.8);
			const aside = ramp(p, FEATURES - 0.8, FEATURES);
			if (title.current) { title.current.style.transform = `translateY(${-out * 45}vh)`; title.current.style.opacity = String(1 - ramp(p, 0.1, 0.65)); }
			// The spotlight fades in with the conversation and out before the
			// office moves aside, so the office never jumps in brightness.
			const spot = ramp(p, 0.45, WORKFLOW) * (1 - ramp(p, WORKFLOW + 4 * STEP - 0.2, FEATURES - 0.6));
			setFade(spot, ramp(p, FEATURES - 0.8, FEATURES));
			if (flow.current) flow.current.style.opacity = String(spot);
			if (list.current) list.current.style.opacity = String(ramp(p, FEATURES - 0.5, FEATURES));
			if (field.current) {
				field.current.style.transform = narrow
					? `translateY(${-aside * 14 - ramp(p, 0.4, WORKFLOW) * 10}svh) scale(${1 - aside * 0.08})`
					: `translateX(${-aside * 19}vw) scale(${1 - aside * 0.2})`;
				field.current.style.opacity = String(0.4 + ramp(p, 0.4, WORKFLOW) * 0.25 + aside * 0.33);
				field.current.dataset.live = aside >= 1 ? 'true' : 'false';
			}
			const s = p > 0.45 && p < FEATURES - 0.6 ? clamp(Math.floor((p - WORKFLOW + STEP / 2) / STEP), 0, 3) : -1;
			const f = p >= FEATURES - 0.8 ? clamp(Math.floor((p - FEATURES + FEATURE / 2) / FEATURE), 0, 5) : -1;
			setStep(s);
			setFeature(f);
		};
		const schedule = () => { raf ||= requestAnimationFrame(apply); };
		apply();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
	}, [still]);

	// Each page, then the section after the story, pulls the scroll onto it.
	useEffect(() => {
		if (still) return;
		return magnet(() => {
			const el = story.current;
			if (!el) return [];
			const tops = [...el.querySelectorAll<HTMLElement>('.snaps i')].map(i => i.getBoundingClientRect().top + window.scrollY);
			return [...tops, el.getBoundingClientRect().bottom + window.scrollY].map(Math.round);
		});
	}, [still]);

	useEffect(() => { setStory(step < 0 ? undefined : step); }, [step]);
	useEffect(() => { setHighlight(feature < 0 ? undefined : features[feature].doing); }, [feature]);
	useEffect(() => () => { setStory(undefined); setHighlight(undefined); setFade(1, 1); }, []);

	const goTo = useCallback((i: number) => {
		const top = story.current?.offsetTop ?? 0;
		window.scrollTo({ top: top + (FEATURES + i * FEATURE) * window.innerHeight + 1, behavior: still ? 'auto' : 'smooth' });
	}, [still]);

	// Which calf is under the pointer, on the canvas's own pixels.
	const hit = (event: PointerEvent<HTMLDivElement>) => {
		const canvas = event.currentTarget.querySelector('canvas');
		if (!canvas || field.current?.dataset.live !== 'true') return undefined;
		const r = canvas.getBoundingClientRect();
		return calfAt((event.clientX - r.left) / r.width * canvas.width, (event.clientY - r.top) / r.height * canvas.height, canvas.width, canvas.height);
	};
	const hover = (event: PointerEvent<HTMLDivElement>) => {
		const a = hit(event);
		const stage = event.currentTarget.parentElement!.getBoundingClientRect();
		const i = a && featureFor(a);
		setTip(a ? { x: event.clientX - stage.left, y: event.clientY - stage.top, text: i === undefined ? doing[a] : `${doing[a]} · ${features[i].title}` } : undefined);
	};
	const click = (event: PointerEvent<HTMLDivElement>) => {
		const a = hit(event);
		const i = a && featureFor(a);
		if (i !== undefined) goTo(i);
	};

	return (
		<div className={`story${still ? ' still' : ''}`} ref={story} style={still ? undefined : { height: `${(LENGTH + 1) * 100}svh` }}>
			{still ? null : (
				<div className="snaps" aria-hidden="true">
					{[0, ...steps.map((_, i) => WORKFLOW + i * STEP), ...features.map((_, i) => FEATURES + i * FEATURE)].map(at => (
						<i key={at} id={at === WORKFLOW ? 'how' : at === FEATURES ? 'features' : undefined} style={{ top: `${at * 100}svh` }} />
					))}
				</div>
			)}
			<div className="stage">
				<div className="stage-field" ref={field} onPointerMove={hover} onPointerLeave={() => setTip(undefined)} onPointerUp={click} style={{ cursor: tip && !tip.text.startsWith('Napping') && !tip.text.startsWith('High') ? 'pointer' : undefined }}>
					<VoxelCanvas className="hero-field" scene={officeVoxels} frame={officeFrame} gpu pixel={2} fps={20} still={24} label="An office of small voxel calves working at their desks, passing work around, fetching milk tea and napping" />
				</div>
				{tip ? <div className="calf-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div> : null}

				<div className="hero-copy" ref={title}>{hero}</div>

				<section className="flow" ref={flow} aria-label="How a task runs">
					<ol className="flow-steps">
						{steps.map((s, i) => (
							<li key={s.title} className={step === i || still ? 'on' : undefined}>
								<span className="flow-n">{i + 1}</span>
								<div><h3>{s.title}</h3><p>{s.text}</p></div>
							</li>
						))}
					</ol>
					<Chat step={still ? 3 : step} />
				</section>

				<section className="feature-list" ref={list} id={still ? 'features' : undefined} aria-label="Features">
					<p className="feature-kicker">Click a calf to see what it is doing</p>
					<ul>
						{features.map((f, i) => (
							<li key={f.title} className={feature === i || still ? 'on' : undefined}>
								<button type="button" onClick={() => goTo(i)} aria-current={feature === i}>
									<PixelIcon name={f.icon} size={18} />
									<span className="feature-title">{f.title}</span>
								</button>
								<div className="feature-more">
									<p>{f.text}</p>
									<p className="feature-look">In the office: {f.look}</p>
								</div>
							</li>
						))}
					</ul>
				</section>
			</div>
		</div>
	);
}
