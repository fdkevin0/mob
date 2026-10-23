import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { aimAt, Cursor, type Aim } from './Cursor';
import { Calf } from '../../components/brand/Logo';
import { BrandIcon, modelBrand, runtimeBrand } from '../../chat/brandIcons';
import { AlertIcon, CheckIcon, CrossIcon, FileIcon, GlobeIcon, HandIcon, MessageIcon, OpenIcon, PencilIcon, PlusIcon, SearchIcon, SparkIcon, StopIcon, TerminalIcon } from '../../chat/icons';
import { begin, clock, count, decide, finish, money, project, reported, stop, tasks, view, waitingFor, type Decision, type Run, type Status, type Task, type Tool, type View } from './orchestra';
import './demo.css';

// A replica of Mob's Agents page, replaying one goal split over several coding
// agents. Until the visitor touches it an autopilot approves and opens cards;
// after that the visitor approves, stops, instructs and opens them.

const TICK = 100;
const AIM_AFTER = 1600;
const NEXT_AFTER = 8000;

const statuses: Record<Status, { label: string; icon?: ReactNode }> = {
	running: { label: 'Running', icon: <span className="spinner" aria-hidden="true" /> },
	waiting: { label: 'Needs you', icon: <HandIcon /> },
	review: { label: 'Done', icon: <CheckIcon /> },
	failed: { label: 'Failed', icon: <AlertIcon /> },
	stopped: { label: 'Stopped' },
	idle: { label: 'Done', icon: <CheckIcon /> },
};
const toolIcons: Record<Tool, ReactNode> = { read: <FileIcon />, edit: <PencilIcon />, execute: <TerminalIcon />, search: <SearchIcon />, fetch: <GlobeIcon />, think: <SparkIcon /> };

function Avatar({ task }: { task: Task }) {
	const brand = runtimeBrand(task.agent);
	return <span className="o-avatar">{task.agent === 'mob' ? <Calf size={18} /> : brand ? <BrandIcon brand={brand} size={16} /> : null}</span>;
}

type Acts = { decide: (d: Decision) => void; stop: (id: string) => void; open: (id: string) => void; instruct: (id: string, text: string) => void };

function Card({ v, acts, approveRef, selected, small }: { v: View; acts: Acts; approveRef: RefObject<HTMLButtonElement | null>; selected: boolean; small?: boolean }) {
	const { task, status } = v;
	const [instructing, setInstructing] = useState(false);
	const [text, setText] = useState('');
	const model = modelBrand(task.model, task.agent);
	const s = statuses[status];
	const send = (e: FormEvent) => { e.preventDefault(); if (text.trim()) { acts.instruct(task.id, text.trim()); setText(''); setInstructing(false); } };
	const live = status === 'running' || status === 'waiting';
	return (
		<article className={`o-card${small ? ' small' : ''}`} data-id={task.id} data-status={status} aria-current={selected || undefined} onClick={e => { if (!(e.target as Element).closest('button, input, form')) acts.open(task.id); }}>
			<header>
				<Avatar task={task} />
				<div className="o-name">
					<strong>{task.label}</strong>
					<small>{model ? <BrandIcon brand={model} size={11} /> : null}{task.model}</small>
				</div>
				<span className="o-status" data-status={status}>{s.icon}{v.checking ? 'Checking' : s.label}</span>
			</header>
			<p className="o-task"><span className="o-tools">{task.tools.map(t => <span key={t} title={t}>{toolIcons[t]}</span>)}</span>{task.title}</p>
			{task.branch ? <p className="o-branch">{project} · {task.branch}</p> : null}
			<div className="o-plan"><span style={{ width: `${(v.done / task.steps) * 100}%` }} /></div>
			{v.asking && task.waits ? (
				<div className="o-approval">
					<p>{task.waits.tool}</p>
					<pre>{task.waits.text.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>{l}{'\n'}</span>)}</pre>
					<div>
						<button type="button" className="o-btn approve" ref={approveRef} onClick={() => acts.decide('allow')}>Approve</button>
						<button type="button" className="o-btn" onClick={() => acts.decide('always')}>Always allow</button>
						<button type="button" className="o-btn deny" onClick={() => acts.decide('deny')}>Deny</button>
					</div>
				</div>
			) : null}
			{instructing ? (
				<form className="o-inline" onSubmit={send}>
					<input aria-label={`Instruction for ${task.label}`} placeholder="Tell the agent…" value={text} onChange={e => setText(e.target.value)} autoFocus />
					<button type="submit" className="o-btn approve" disabled={!text.trim()}>Send</button>
				</form>
			) : null}
			<footer>
				<span>{small ? <><strong>{money(v.cost)}</strong> · {clock(v.seconds)}</> : <><strong>{money(v.cost)} · {count(v.tokens)} tokens</strong> · {v.done}/{task.steps} steps · {clock(v.seconds)}</>}</span>
				<span className="o-acts">
					{task.agent !== 'mob' ? <button type="button" aria-label={`Instruct ${task.label}: ${task.title}`} aria-pressed={instructing} title="Tell the agent what to do next" onClick={() => setInstructing(!instructing)}><MessageIcon /></button> : null}
					{live && task.agent !== 'mob' ? <button type="button" aria-label={`Stop ${task.label}: ${task.title}`} title="Stop the agent; its branch stays" onClick={() => acts.stop(task.id)}><StopIcon /></button> : null}
					<button type="button" aria-label={`Open ${task.label}: ${task.title}`} title="Open" onClick={() => acts.open(task.id)}><OpenIcon /></button>
				</span>
			</footer>
		</article>
	);
}

function Drawer({ v, notes, close }: { v: View; notes: string[]; close: () => void }) {
	const { task } = v;
	return (
		<aside className="o-drawer" aria-label={`${task.label}: ${task.title}`}>
			<header>
				<Avatar task={task} />
				<div className="o-name"><strong>{task.title}</strong><small>{task.label} · {task.model}</small></div>
				<button type="button" aria-label="Close" onClick={close}><CrossIcon /></button>
			</header>
			<dl>
				<div><dt>Status</dt><dd><span className="o-status" data-status={v.status}>{statuses[v.status].icon}{v.checking ? 'Checking' : statuses[v.status].label}</span></dd></div>
				{task.branch ? <div><dt>Branch</dt><dd><code>{task.branch}</code></dd></div> : null}
				{task.diff && v.status === 'review' ? <div><dt>task_diff</dt><dd><code>{task.diff}</code></dd></div> : null}
				<div><dt>Spent</dt><dd>{money(v.cost)} · {count(v.tokens)} tokens · {clock(v.seconds)}</dd></div>
			</dl>
			<ol className="o-log">
				{[...v.log, ...notes].map((l, i) => <li key={i} className={l.startsWith('You:') ? 'you' : l.startsWith('FAIL') ? 'fail' : undefined}>{l}</li>)}
				{v.status === 'running' ? <li className="o-typing">working…</li> : null}
			</ol>
		</aside>
	);
}

export function Agents() {
	const [still] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
	const [run, setRun] = useState<Run>(() => still ? finish() : begin());
	const [pilot, setPilot] = useState(!still);
	const [seen, setSeen] = useState(false);
	const [open, setOpen] = useState<string>();
	const [notes, setNotes] = useState<Record<string, string[]>>({});
	const [cursor, setCursor] = useState<Aim>();
	const stage = useRef<HTMLDivElement>(null);
	const approveRef = useRef<HTMLButtonElement>(null);
	const treeRef = useRef<HTMLDivElement>(null);
	const end = reported(run);
	const over = run.t >= end;

	useEffect(() => {
		const el = stage.current;
		if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
		const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.35 });
		io.observe(el);
		return () => io.disconnect();
	}, []);

	// The clock runs while the demo is on screen, until Mob has reported.
	useEffect(() => {
		if (!seen || still || over) return;
		const t = setInterval(() => setRun(r => ({ ...r, t: Math.round((r.t + TICK / 1000) * 10) / 10 })), TICK);
		return () => clearInterval(t);
	}, [seen, still, over]);

	const asking = waitingFor(run)?.id;
	const flop = tasks.find(t => t.failed)!;
	const failed = view(run, flop)?.status === 'failed';
	// The autopilot approves when asked, looks at the failed test run, and
	// starts again a while after the report.
	useEffect(() => {
		if (!pilot || !seen) return;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const aim = (press: boolean) => { const at = aimAt(approveRef.current, stage.current, press); if (at) setCursor(at); };
		if (asking) {
			timers.push(setTimeout(() => aim(false), AIM_AFTER));
			timers.push(setTimeout(() => aim(true), AIM_AFTER + 900));
			timers.push(setTimeout(() => { setRun(r => decide(r, 'allow')); setCursor(c => c && { x: c.x + 120, y: c.y + 70, press: false }); }, AIM_AFTER + 1060));
		} else if (over) {
			timers.push(setTimeout(() => { setRun(begin()); setOpen(undefined); }, NEXT_AFTER));
		}
		return () => timers.forEach(clearTimeout);
	}, [pilot, seen, asking, over]);
	useEffect(() => {
		if (!pilot || !failed) return;
		setOpen(flop.id);
		const t = setTimeout(() => setOpen(undefined), 3200);
		return () => clearTimeout(t);
	}, [pilot, failed]);

	// While it drives, the autopilot keeps the newest card, or the one asking, in view.
	const newest = tasks.filter(t => t.start <= run.t).at(-1)?.id;
	const focus = asking ?? (failed && pilot ? flop.id : newest);
	useEffect(() => {
		const tree = treeRef.current, el = tree?.querySelector(`[data-id="${focus}"]`);
		if (!pilot || !tree || !el) return;
		const c = tree.getBoundingClientRect(), r = el.getBoundingClientRect();
		if (r.bottom > c.bottom) tree.scrollBy({ top: Math.min(r.bottom - c.bottom + 16, r.top - c.top - 8), behavior: 'smooth' });
		else if (r.top < c.top) tree.scrollBy({ top: r.top - c.top - 8, behavior: 'smooth' });
	}, [pilot, focus, run.decided]);

	const takeOver = () => { if (pilot) { setPilot(false); setCursor(undefined); } };
	const acts: Acts = {
		decide: d => setRun(r => decide(r, d)),
		stop: id => setRun(r => stop(r, id)),
		open: id => setOpen(o => o === id ? undefined : id),
		instruct: (id, text) => setNotes(n => ({ ...n, [id]: [...(n[id] ?? []), `You: ${text}`, 'Got it, carrying on with that.'] })),
	};
	const replay = () => { setRun(still ? finish() : begin()); setOpen(undefined); setNotes({}); };

	const views = new Map(tasks.map(t => [t.id, view(run, t)]));
	const shown = [...views.values()].filter((v): v is View => !!v);
	const n = (s: Status) => shown.filter(v => v.status === s).length;
	const total = shown.reduce((sum, v) => sum + v.cost, 0);
	const kids = (id: string) => tasks.filter(t => t.parent === id && views.get(t.id));
	const card = (t: Task, small?: boolean) => <Card v={views.get(t.id)!} acts={acts} approveRef={approveRef} selected={open === t.id} small={small} />;
	const drawer = open ? views.get(open) : undefined;

	return (
		<div className="o-stage" ref={stage} onClickCapture={takeOver}>
			<div className="d-window o-window" aria-label="Mob's Agents page">
				<div className="d-titlebar" aria-hidden="true">
					<span className="d-lights"><i /><i /><i /></span>
					<span className="d-url"><span className="d-lock" />127.0.0.1:8787</span>
				</div>
				<div className="d-app">
					<aside className="d-sidebar">
						<div className="d-brand"><Calf size={24} /><b>mob</b><span>On this computer</span></div>
						<button type="button" className="d-new"><PlusIcon /> New conversation</button>
						<nav aria-label="Demo conversations">
							{tasks.filter(t => views.get(t.id)).map(t => (
								<button type="button" key={t.id} aria-current={open === t.id} onClick={() => acts.open(t.id)}>
									{t.agent === 'mob' ? t.title : `${t.agent === 'dsh' ? 'deepseek' : t.agent}: ${t.title}`}
								</button>
							))}
						</nav>
						<div className="d-side-foot">
							<span className="o-here">Agents</span><span>Plugins &amp; cloud services</span><span>Token usage</span>
							<p><i className="d-dot" /> History on this computer</p>
						</div>
					</aside>
					<div className="d-main o-main">
						<header className="o-head">
							<h3><SparkIcon /> Agents</h3>
							<div className="o-summary">
								<span>{shown.length} agents</span>
								{n('running') ? <span className="o-pill" data-status="running">{n('running')} running</span> : null}
								{n('waiting') ? <span className="o-pill" data-status="waiting">{n('waiting')} needs you</span> : null}
								{n('failed') ? <span className="o-pill" data-status="failed">{n('failed')} failed</span> : null}
								<strong>{money(total)}</strong>
							</div>
						</header>
						<div className="o-tree" ref={treeRef}>
							<div className="o-root">{card(tasks[0])}</div>
							{kids('mob').length ? (
								<ul className="o-row">
									{kids('mob').map(t => (
										<li key={t.id} data-status={views.get(t.id)!.status}>
											{card(t)}
											{kids(t.id).length ? <ul className="o-sub">{kids(t.id).map(c => <li key={c.id} data-status={views.get(c.id)!.status}>{card(c, true)}</li>)}</ul> : null}
										</li>
									))}
								</ul>
							) : null}
						</div>
						{drawer ? <Drawer v={drawer} notes={notes[drawer.task.id] ?? []} close={() => setOpen(undefined)} /> : null}
						{over ? (
							<div className="o-report" role="status">
								<Calf size={20} />
								<p><strong>{run.decision === 'deny' ? 'retry-t2 is ready; flaky-t1 waits for your test run.' : 'Both branches are ready to merge.'}</strong> Checked with task_check · {money(total)} · {clock(end)}</p>
								{!pilot ? <button type="button" className="o-btn approve" onClick={replay}>Replay</button> : null}
							</div>
						) : null}
					</div>
				</div>
			</div>
			{pilot && cursor ? <Cursor at={cursor} /> : null}
		</div>
	);
}

