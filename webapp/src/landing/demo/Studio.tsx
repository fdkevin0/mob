import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Calf } from '../../components/brand/Logo';
import { BrandIcon, runtimeBrand } from '../../chat/brandIcons';
import { AlertIcon, ArrowUpIcon, CheckIcon, ChevronIcon, HandIcon, MessageIcon, SparkIcon, StopIcon } from '../../chat/icons';
import { aimAt, Cursor, type Aim } from './Cursor';
import { begin, branches, clock, count, decide, finish, goal, money, project, report, reported, stop, tasks, typed, view, waitingFor, type Decision, type Run, type Status, type Task, type View } from './orchestra';
import './demo.css';

// One replay, two views of it: the conversation where you asked, on the web
// or in a chat app, and the tree of agents doing the work. They move together
// and an approval can be given from either. Until the visitor touches it an
// autopilot drives; after that the visitor does. Nothing calls a model.

export type Channel = 'web' | 'chat';
const TICK = 100;
const AIM_AFTER = 1700;
const NEXT_AFTER = 9000;

const statuses: Record<Status, { label: string; icon?: ReactNode }> = {
	running: { label: 'Running', icon: <span className="spinner" aria-hidden="true" /> },
	waiting: { label: 'Needs you', icon: <HandIcon /> },
	review: { label: 'Done', icon: <CheckIcon /> },
	failed: { label: 'Failed', icon: <AlertIcon /> },
	stopped: { label: 'Stopped', icon: <StopIcon /> },
	idle: { label: 'Done', icon: <CheckIcon /> },
};

const Avatar = ({ task }: { task: Task }) => {
	const brand = runtimeBrand(task.agent);
	return <span className="o-avatar">{task.agent === 'mob' ? <Calf size={16} /> : brand ? <BrandIcon brand={brand} size={14} /> : null}</span>;
};
const Pill = ({ v }: { v: View }) => <span className="o-status" data-status={v.status}>{statuses[v.status].icon}{v.checking ? 'Checking' : statuses[v.status].label}</span>;

// A little Markdown: **bold**, `code`, and | tables |.
function inline(text: string) {
	return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
		part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
		: part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
		: part);
}
function Markdown({ text }: { text: string }) {
	const lines = text.split('\n');
	const blocks: ReactNode[] = [];
	for (let i = 0; i < lines.length;) {
		if (lines[i].startsWith('|')) {
			const rows: string[][] = [];
			for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
			blocks.push(
				<table key={`t${i}`}><thead><tr>{rows[0].map(c => <th key={c}>{c}</th>)}</tr></thead>
				<tbody>{rows.slice(1).map(r => <tr key={r[0]}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table>,
			);
		} else {
			if (lines[i]) blocks.push(<p key={`p${i}`}>{inline(lines[i])}</p>);
			i++;
		}
	}
	return <>{blocks}</>;
}

const asker = tasks.find(t => t.waits)!;
const flop = tasks.find(t => t.failed)!;
const fixer = tasks.find(t => t.parent === flop.parent && t.start > flop.end)!;
const THINK = 0.9;

// What Mob says back, on the web and in a chat app.
function answer(run: Run, views: Map<string, View | undefined>) {
	const total = [...views.values()].reduce((sum, v) => sum + (v?.cost ?? 0), 0);
	const r = report(run, total);
	const rows = branches.map((t, i) => `| \`${t.branch}\` | ${t.label} | ${r.results[i]} | ${money(views.get(t.id)?.cost ?? 0)} |`);
	return { web: [r.lead, '| Branch | Agent | Result | Cost |', ...rows, r.closing].join('\n'), brief: r.brief };
}

// Follows new messages only while the reader is at the bottom, so scrolling
// up to read stays put.
function useFollow(...deps: unknown[]) {
	const ref = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	useLayoutEffect(() => { const el = ref.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, deps);
	const onScroll = () => { const el = ref.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
	return { ref, onScroll };
}

type Acts = { decide: (d: Decision) => void; select: (id: string) => void };

function WebChat({ run, views, channel, acts, approveRef, sendRef }: { run: Run; views: Map<string, View | undefined>; channel: Channel; acts: Acts; approveRef: RefObject<HTMLButtonElement | null>; sendRef: RefObject<HTMLButtonElement | null> }) {
	const follow = useFollow(run.t, run.decided);
	const { t } = run;
	const end = reported(run);
	const asking = views.get(asker.id)?.asking;
	const composing = t < 0 && channel === 'web';
	return (
		<section className="s-chat" aria-label="The conversation">
			<header className="d-head">{t < 0 ? 'New conversation' : goal}</header>
			<div className="d-scroll" ref={follow.ref} onScroll={follow.onScroll}>
				{t < 0 ? (
					<div className="d-empty"><Calf size={40} /><h3>What should the calves do?</h3></div>
				) : (
					<div className="d-thread">
						<div className="d-user">
							{channel === 'chat' ? <span className="d-via">via chat app</span> : null}
							<p className="d-bubble">{goal}</p>
						</div>
						<div className="d-assistant">
							{t < THINK ? <p className="d-thinking">Thinking…</p> : (
								<details className="d-reasoning"><summary><ChevronIcon /> Thought for 2s</summary><p>Two independent changes, so two agents on two branches. Both need tests before I call them done.</p></details>
							)}
							{t >= THINK ? <p className="s-say">On it. I've split this into two tasks:</p> : null}
							{branches.filter(task => views.get(task.id) && t >= THINK).map(task => {
								const v = views.get(task.id)!;
								const kind = v.status === 'review' ? 'done' : v.status === 'failed' || v.status === 'stopped' ? 'failed' : v.status === 'waiting' ? 'waiting' : 'running';
								return (
									<div key={task.id} className={`d-tool ${kind} s-task`}>
										<button type="button" className="s-task-row" onClick={() => acts.select(task.id)} title="Show it in the tree">
											<span className="d-tool-status">{kind === 'running' ? <span className="spinner" aria-hidden="true" /> : statuses[v.status].icon}</span>
											<span className="d-tool-title">Start agent</span>
											<span className="d-tool-detail">{task.label} · {task.title}</span>
											<span className="sr-only">{statuses[v.status].label}</span>
											<ChevronIcon />
										</button>
										{task === asker && asking ? (
											<div className="d-approval">
												<p className="d-approval-q">{task.label} wants to run a command in the sandbox.</p>
												<pre className="d-preview">{asker.waits!.text}</pre>
												<div className="d-approval-actions">
													<button type="button" className="d-btn primary" ref={channel === 'web' ? approveRef : undefined} onClick={() => acts.decide('allow')}>Approve</button>
													<button type="button" className="d-btn" onClick={() => acts.decide('allow')}>Allow in this conversation</button>
													<button type="button" className="d-btn" onClick={() => acts.decide('always')}>Always allow</button>
													<button type="button" className="d-btn ghost" onClick={() => acts.decide('deny')}>Deny</button>
												</div>
											</div>
										) : null}
									</div>
								);
							})}
							{views.get(flop.id)?.status === 'failed' && t >= flop.end + 0.3 ? <p className="s-say">The retry tests caught a declined card being retried. {fixer.label} is fixing it.</p> : null}
							{t >= end - 3 && t < end ? <p className="d-thinking">Checking the branches with task_diff and task_check…</p> : null}
							{t >= end ? <div className="d-answer"><Markdown text={answer(run, views).web} /></div> : null}
						</div>
					</div>
				)}
			</div>
			<div className="d-composer">
				<div className={`d-input${composing ? ' typing' : ''}`}>
					{composing && typed(run) ? <span>{goal.slice(0, typed(run))}<i className="d-caret" /></span> : <span className="d-placeholder">Message Mob, or type / for commands</span>}
				</div>
				<div className="d-bar">
					<span className="d-model">claude-sonnet-5-5 ⌄</span>
					<button type="button" className="d-send" ref={channel === 'web' ? sendRef : undefined} aria-label="Send" disabled={!composing || !typed(run)} tabIndex={-1}><ArrowUpIcon /></button>
				</div>
			</div>
		</section>
	);
}

function Phone({ run, views, channel, acts, approveRef, sendRef }: { run: Run; views: Map<string, View | undefined>; channel: Channel; acts: Acts; approveRef: RefObject<HTMLButtonElement | null>; sendRef: RefObject<HTMLButtonElement | null> }) {
	const follow = useFollow(run.t, run.decided);
	const { t } = run;
	const end = reported(run);
	const v = views.get(asker.id);
	const failed = views.get(flop.id)?.status === 'failed';
	const composing = t < 0 && channel === 'chat';
	return (
		<div className="d-phone" aria-label="Mob in a chat app">
			<div className="im-head">
				<span className="im-back" aria-hidden="true">‹</span>
				<span className="im-avatar"><Calf size={22} /></span>
				<div><b>Mob</b><small>{t >= 0 && t < end ? 'typing…' : 'bot'}</small></div>
			</div>
			<div className="im-chat" ref={follow.ref} onScroll={follow.onScroll}>
				<p className="im-day">Today</p>
				<div className="im-msg in"><p>Hi! Ask me anything, and I will check with you before I change something.</p><time>08:58</time></div>
				{t >= 0 ? <div className="im-msg out"><p>{goal}</p><time>09:02 ✓✓</time></div> : null}
				{t >= THINK ? <div className="im-msg in"><p>On it: Codex takes the flaky test, Claude Agent the retries.</p><time>09:02</time></div> : null}
				{v && t >= asker.waits!.at ? (
					<div className="im-msg in">
						<p className="im-pre">Codex wants to run a command:{'\n'}{asker.waits!.text}</p>
						<time>09:04</time>
						{v.asking ? (
							<div className="im-keys">
								<button type="button" ref={channel === 'chat' ? approveRef : undefined} onClick={() => acts.decide('allow')}>Approve</button>
								<button type="button" onClick={() => acts.decide('always')}>Always</button>
								<button type="button" onClick={() => acts.decide('deny')}>Deny</button>
							</div>
						) : run.decision ? <p className={`im-decided${run.decision === 'deny' ? ' no' : ''}`}>{run.decision === 'deny' ? '✗ Denied' : run.decision === 'always' ? '✓ Always allowed' : '✓ Approved'}</p> : null}
					</div>
				) : null}
				{failed && t >= flop.end + 0.3 ? <div className="im-msg in"><p>Heads up: a retry test failed. {fixer.label} is fixing it.</p><time>09:06</time></div> : null}
				{t >= end ? <div className="im-msg in"><p>{answer(run, views).brief}</p><time>09:09</time></div> : null}
			</div>
			<div className="im-compose">
				<span className={composing && typed(run) ? 'im-typed' : 'im-placeholder'}>{composing && typed(run) ? <>{goal.slice(0, typed(run))}<i className="d-caret" /></> : 'Message'}</span>
				<button type="button" ref={channel === 'chat' ? sendRef : undefined} aria-label="Send" disabled={!composing || !typed(run)} tabIndex={-1}><ArrowUpIcon /></button>
			</div>
		</div>
	);
}

function Row({ v, depth, open, run, acts, onStop, onInstruct, notes }: { v: View; depth: number; open: boolean; run: Run; acts: Acts; onStop: (id: string) => void; onInstruct: (id: string, text: string) => void; notes: string[] }) {
	const { task, status } = v;
	const [text, setText] = useState('');
	const send = (e: FormEvent) => { e.preventDefault(); if (text.trim()) { onInstruct(task.id, text.trim()); setText(''); } };
	const live = status === 'running' || status === 'waiting';
	const expanded = open || v.asking;
	return (
		<li className="s-node" data-status={status} data-id={task.id} style={{ '--depth': depth } as CSSProperties}>
			<div className="o-card s-card" aria-current={open || undefined} data-status={status}>
				<button type="button" className="s-head" aria-expanded={expanded} onClick={() => acts.select(task.id)}>
					<Avatar task={task} />
					<span className="s-name"><strong>{task.label}</strong><small>{task.title}</small></span>
					<Pill v={v} />
				</button>
				<div className="o-plan"><span style={{ width: `${(v.done / task.steps) * 100}%` }} /></div>
				<p className="s-meta">{task.branch ? <code>{task.branch}</code> : <span>{task.model}</span>}<span>{money(v.cost)} · {count(v.tokens)} · {clock(v.seconds)}</span></p>
				{v.asking ? (
					<div className="o-approval">
						<p>{asker.waits!.tool}</p>
						<pre>{asker.waits!.text}</pre>
						<div>
							<button type="button" className="o-btn approve" onClick={() => acts.decide('allow')}>Approve</button>
							<button type="button" className="o-btn" onClick={() => acts.decide('always')}>Always allow</button>
							<button type="button" className="o-btn deny" onClick={() => acts.decide('deny')}>Deny</button>
						</div>
					</div>
				) : null}
				{open ? (
					<div className="s-detail">
						<ol className="o-log">
							{[...v.log, ...notes].map((l, i) => <li key={i} className={l.startsWith('You:') ? 'you' : l.startsWith('FAIL') ? 'fail' : undefined}>{l}</li>)}
							{status === 'running' ? <li className="o-typing">working…</li> : null}
						</ol>
						{task.diff && status === 'review' ? <p className="s-diff">task_diff <code>{task.diff}</code></p> : null}
						{task.agent !== 'mob' ? (
							<form className="o-inline" onSubmit={send}>
								<input aria-label={`Instruction for ${task.label}`} placeholder="Tell the agent…" value={text} onChange={e => setText(e.target.value)} />
								<button type="submit" className="o-btn" aria-label="Send instruction" disabled={!text.trim()}><MessageIcon /></button>
								{live ? <button type="button" className="o-btn" aria-label={`Stop ${task.label}`} title="Stop the agent; its branch stays" onClick={() => onStop(task.id)}><StopIcon /></button> : null}
							</form>
						) : null}
					</div>
				) : null}
			</div>
		</li>
	);
}

export function Studio() {
	const [still] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
	const [run, setRun] = useState<Run>(() => still ? finish() : begin());
	const [channel, setChannel] = useState<Channel>('web');
	const [pilot, setPilot] = useState(!still);
	const [seen, setSeen] = useState(false);
	const [open, setOpen] = useState<string>();
	const [notes, setNotes] = useState<Record<string, string[]>>({});
	const [cursor, setCursor] = useState<Aim>();
	const stage = useRef<HTMLDivElement>(null);
	const tree = useRef<HTMLDivElement>(null);
	const approveRef = useRef<HTMLButtonElement>(null);
	const sendRef = useRef<HTMLButtonElement>(null);
	const end = reported(run);
	const over = run.t >= end;
	const asking = waitingFor(run)?.id;
	const failed = view(run, flop)?.status === 'failed';
	const sent = run.t >= 0;

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

	// The autopilot presses Send, approves where you asked from, looks at the
	// failed run, and starts again a while after the report.
	useEffect(() => {
		if (!pilot || !seen) return;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const aim = (el: RefObject<HTMLButtonElement | null>, press: boolean) => { const at = aimAt(el.current, stage.current, press); if (at) setCursor(at); };
		if (!sent) {
			timers.push(setTimeout(() => aim(sendRef, false), 1200));
			timers.push(setTimeout(() => aim(sendRef, true), 2300));
		} else if (asking) {
			timers.push(setTimeout(() => aim(approveRef, false), AIM_AFTER));
			timers.push(setTimeout(() => aim(approveRef, true), AIM_AFTER + 900));
			timers.push(setTimeout(() => { setRun(r => decide(r, 'allow')); setCursor(c => c && { x: c.x + 120, y: c.y + 80, press: false }); }, AIM_AFTER + 1060));
		} else if (over) {
			timers.push(setTimeout(() => { setRun(begin()); setOpen(undefined); setChannel(c => c === 'web' ? 'chat' : 'web'); }, NEXT_AFTER));
		}
		return () => timers.forEach(clearTimeout);
	}, [pilot, seen, sent, asking, over, channel]);
	useEffect(() => {
		if (!pilot || !failed) return;
		setOpen(flop.id);
		const t = setTimeout(() => setOpen(undefined), 3400);
		return () => clearTimeout(t);
	}, [pilot, failed]);
	useEffect(() => { if (cursor?.press) { const t = setTimeout(() => setCursor(c => c && { ...c, press: false }), 220); return () => clearTimeout(t); } }, [cursor?.press]);

	// While it drives, the autopilot keeps the newest agent, or the one asking, in view.
	const newest = tasks.filter(t => t.start <= run.t).at(-1)?.id;
	const focus = asking ?? (failed && pilot ? flop.id : newest);
	useEffect(() => {
		const box = tree.current, el = box?.querySelector(`[data-id="${focus}"]`);
		if (!pilot || !box || !el) return;
		const c = box.getBoundingClientRect(), r = el.getBoundingClientRect();
		if (r.bottom > c.bottom) box.scrollBy({ top: Math.min(r.bottom - c.bottom + 12, r.top - c.top - 8), behavior: 'smooth' });
		else if (r.top < c.top) box.scrollBy({ top: r.top - c.top - 8, behavior: 'smooth' });
	}, [pilot, focus, run.decided]);

	const takeOver = () => { if (pilot) { setPilot(false); setCursor(undefined); } };
	const acts: Acts = {
		decide: d => setRun(r => decide(r, d)),
		select: id => setOpen(o => o === id ? undefined : id),
	};
	const replay = (c = channel) => { setChannel(c); setRun(still ? finish() : begin()); setOpen(undefined); setNotes({}); };
	// Typing goes to the channel picked; a switch before sending just moves it.
	const pickChannel = (c: Channel) => { takeOver(); if (c !== channel) replay(c); };

	const views = new Map(tasks.map(t => [t.id, view(run, t)]));
	const shown = [...views.values()].filter((v): v is View => !!v);
	const n = (s: Status) => shown.filter(v => v.status === s).length;
	const total = shown.reduce((sum, v) => sum + v.cost, 0);
	const done = over ? report(run, total) : undefined;
	const all = done?.ready === branches.length;
	const depth = (t: Task): number => t.parent ? 1 + depth(tasks.find(p => p.id === t.parent)!) : 0;
	// Depth-first, so each agent sits under the one that started it.
	const ordered: Task[] = [];
	const walk = (id?: string) => tasks.filter(t => t.parent === id).forEach(t => { ordered.push(t); walk(t.id); });
	walk(undefined);

	return (
		<div className="s-wrap">
			<div className="demo-controls">
				<div className="demo-channels" role="group" aria-label="Ask from">
					<span>Ask from</span>
					{(['web', 'chat'] as Channel[]).map(c => <button type="button" key={c} aria-pressed={channel === c} onClick={() => pickChannel(c)}>{c === 'web' ? 'Web app' : 'Chat app'}</button>)}
				</div>
				<div className="demo-channels" role="group" aria-label="Replay">
					<button type="button" onClick={() => { takeOver(); replay(); }}>↻ Replay</button>
				</div>
			</div>
			<div className="s-stage" ref={stage} data-channel={channel} onClickCapture={e => { if (e.isTrusted) takeOver(); }}>
				<div className="d-window s-window" aria-label="The Mob app">
					<div className="d-titlebar" aria-hidden="true">
						<span className="d-lights"><i /><i /><i /></span>
						<span className="d-url"><span className="d-lock" />127.0.0.1:8787</span>
					</div>
					<div className="s-app">
						<WebChat run={run} views={views} channel={channel} acts={acts} approveRef={approveRef} sendRef={sendRef} />
						<section className="s-agents" aria-label="Agents">
							<header className="o-head">
								<h3><SparkIcon /> Agents</h3>
								<div className="o-summary">
									<span>{shown.length}</span>
									{n('running') ? <span className="o-pill" data-status="running">{n('running')} running</span> : null}
									{n('waiting') ? <span className="o-pill" data-status="waiting">{n('waiting')} needs you</span> : null}
									{n('failed') ? <span className="o-pill" data-status="failed">{n('failed')} failed</span> : null}
									<strong>{money(total)}</strong>
								</div>
							</header>
							<div className="s-tree" ref={tree}>
								{shown.length ? (
									<ul>
										{ordered.filter(t => views.get(t.id)).map(t => (
											<Row key={t.id} v={views.get(t.id)!} depth={depth(t)} open={open === t.id} run={run} acts={acts} notes={notes[t.id] ?? []}
												onStop={id => setRun(r => stop(r, id))}
												onInstruct={(id, text) => setNotes(x => ({ ...x, [id]: [...(x[id] ?? []), `You: ${text}`, 'Got it, carrying on with that.'] }))} />
										))}
									</ul>
								) : <p className="s-idle">No agents yet. Ask for something and Mob will hand out the work here, in <code>{project}</code>.</p>}
							</div>
							{done ? <p className="s-report" role="status" data-partial={!all || undefined}>{all ? <CheckIcon /> : <AlertIcon />} {done.banner} · {money(total)}</p> : null}
						</section>
					</div>
				</div>
				<Phone run={run} views={views} channel={channel} acts={acts} approveRef={approveRef} sendRef={sendRef} />
				{pilot && cursor ? <Cursor at={cursor} /> : null}
			</div>
		</div>
	);
}
