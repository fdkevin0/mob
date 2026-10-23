import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Calf } from '../../components/brand/Logo';
import { ArrowUpIcon, CheckIcon, ChevronIcon, CopyIcon, CrossIcon, HandIcon, PlusIcon } from '../../chat/icons';
import './demo.css';
import { briefOf, decide, delay, finish, scenarios, shownAnswer, start, tick, visible, type Channel, type Decision, type State, type Step, type StepStatus } from './script';

// A replica of the Mob app, and of Mob on Telegram, playing recorded tasks.
// Until the visitor touches it an autopilot cursor drives it; after that it
// waits for them, approvals included. Nothing here calls a model.

const AIM_AFTER = 1400; // how long an approval waits before the autopilot reaches for it
const PRESS_AFTER = 900;
const NEXT_AFTER = 6000; // how long a finished task stays before the next one

// A little Markdown: **bold**, `code`, - lists and | tables |. Table rows
// show only once complete, so a half-streamed row never flickers in.
function inline(text: string) {
	return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
		part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
		: part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
		: part);
}
export function Markdown({ text, done }: { text: string; done: boolean }) {
	const lines = text.split('\n');
	const blocks: ReactNode[] = [];
	for (let i = 0; i < lines.length;) {
		const complete = (n: number) => done || n < lines.length - 1;
		if (lines[i].startsWith('|')) {
			const rows: string[][] = [];
			for (; i < lines.length && lines[i].startsWith('|'); i++) if (complete(i)) rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
			if (rows.length) blocks.push(
				<table key={i}><thead><tr>{rows[0].map(c => <th key={c}>{c}</th>)}</tr></thead>
				<tbody>{rows.slice(1).map(r => <tr key={r[0]}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>,
			);
		} else if (lines[i].startsWith('- ')) {
			const items: string[] = [];
			for (; i < lines.length && lines[i].startsWith('- '); i++) items.push(lines[i].slice(2));
			blocks.push(<ul key={i}>{items.map(t => <li key={t}>{inline(t)}</li>)}</ul>);
		} else {
			if (lines[i]) blocks.push(<p key={i}>{inline(lines[i])}</p>);
			i++;
		}
	}
	return <>{blocks}</>;
}

const statusIcon: Record<StepStatus, ReactNode> = {
	running: <span className="spinner" aria-hidden="true" />,
	waiting: <HandIcon />,
	done: <CheckIcon />,
	denied: <CrossIcon />,
};
const statusLabel: Record<StepStatus, string> = { running: 'Running', waiting: 'Waiting for your approval', done: 'Done', denied: 'Denied' };

function WebStep({ step, status, onDecide, approveRef }: { step: Step; status: StepStatus; onDecide: (d: Decision) => void; approveRef: RefObject<HTMLButtonElement | null> }) {
	if (step.kind === 'think') {
		if (status === 'running') return <p className="d-thinking">Thinking…</p>;
		return (
			<details className="d-reasoning">
				<summary><ChevronIcon /> Thought for {Math.round(step.ms / 1000)}s</summary>
				<p>{step.text}</p>
			</details>
		);
	}
	const kind = status === 'denied' ? 'failed' : status;
	return (
		<details className={`d-tool ${kind}`} open={status === 'waiting' || undefined}>
			<summary onClick={status === 'waiting' ? e => e.preventDefault() : undefined}>
				<span className="d-tool-status" title={statusLabel[status]}>{statusIcon[status]}</span>
				<span className="d-tool-title">{step.title}</span>
				<span className="d-tool-detail">{step.detail}</span>
				<span className="sr-only">{statusLabel[status]}</span>
				<ChevronIcon />
			</summary>
			{status === 'waiting' && step.kind === 'approve' ? (
				<div className="d-approval">
					<p className="d-approval-q">{step.question}</p>
					{step.preview ? <pre className="d-preview">{step.preview.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>{l}{'\n'}</span>)}</pre> : null}
					<div className="d-approval-actions">
						<button type="button" className="d-btn primary" ref={approveRef} onClick={() => onDecide('allow')}>Approve</button>
						<button type="button" className="d-btn" onClick={() => onDecide('allow')}>Allow in this conversation</button>
						<button type="button" className="d-btn" onClick={() => onDecide('always')}>Always allow</button>
						<button type="button" className="d-btn ghost" onClick={() => onDecide('deny')}>Deny</button>
					</div>
					<p className="d-approval-note">Approval expires after one hour. Remembered approvals are listed by /grants.</p>
				</div>
			) : (
				<div className="d-tool-body">
					{step.kind === 'approve' && step.preview ? <pre>{step.preview}</pre> : null}
					<pre>{status === 'denied' ? 'Denied by you' : status === 'running' ? '…' : step.result}</pre>
				</div>
			)}
		</details>
	);
}

type Aim = 'send' | 'approve';

function WebApp({ state, onPick, onDecide, refs }: { state: State; onPick: (i: number) => void; onDecide: (d: Decision) => void; refs: Record<Aim, RefObject<HTMLButtonElement | null>> }) {
	const sc = scenarios[state.scenario];
	const scroll = useRef<HTMLDivElement>(null);
	const typing = state.phase === 'compose' && state.channel === 'web' && state.typed > 0;
	const steps = visible(state);
	const answering = state.phase === 'answer' || state.phase === 'done';
	useLayoutEffect(() => {
		const el = scroll.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [state]);
	return (
		<div className="d-window" aria-label="The Mob web app">
			<div className="d-titlebar" aria-hidden="true">
				<span className="d-lights"><i /><i /><i /></span>
				<span className="d-url"><span className="d-lock" />127.0.0.1:8787</span>
			</div>
			<div className="d-app">
				<aside className="d-sidebar">
					<div className="d-brand"><Calf size={24} /><b>mob</b><span>On this computer</span></div>
					<button type="button" className="d-new" onClick={() => onPick(state.scenario)}><PlusIcon /> New conversation</button>
					<nav aria-label="Demo conversations">
						{scenarios.map((s, i) => (
							<button type="button" key={s.title} aria-current={i === state.scenario} onClick={() => onPick(i)}>
								{s.title}{i === state.scenario && state.channel === 'telegram' ? <small>Telegram</small> : null}
							</button>
						))}
					</nav>
					<div className="d-side-foot">
						<span>Agents</span><span>Plugins &amp; cloud services</span><span>Token usage</span>
						<p><i className="d-dot" /> History on this computer</p>
					</div>
				</aside>
				<div className="d-main">
					<header className="d-head">{state.phase === 'compose' ? 'New conversation' : sc.prompt}</header>
					<div className="d-scroll" ref={scroll}>
						{state.phase === 'compose' ? (
							<div className="d-empty">
								<Calf size={44} />
								<h3>What should the calves do?</h3>
								<div className="d-suggest">
									{scenarios.map((s, i) => <button type="button" key={s.title} onClick={() => onPick(i)}>{s.prompt}</button>)}
								</div>
							</div>
						) : (
							<div className="d-thread">
								<div className="d-user">
									{state.channel === 'telegram' ? <span className="d-via">via Telegram</span> : null}
									<p className="d-bubble">{sc.prompt}</p>
								</div>
								<div className="d-assistant">
									{steps.map(({ step, status }, i) => <WebStep key={i} step={step} status={status} onDecide={onDecide} approveRef={refs.approve} />)}
									{answering ? (
										<div className={`d-answer${state.phase === 'answer' ? ' streaming' : ''}`}>
											<Markdown text={shownAnswer(state)} done={state.phase === 'done'} />
										</div>
									) : null}
									{state.phase === 'done' ? <div className="d-actions"><button type="button" aria-label="Copy reply" title="Copy reply"><CopyIcon /></button></div> : null}
								</div>
							</div>
						)}
					</div>
					<div className="d-composer">
						<div className={`d-input${typing ? ' typing' : ''}`}>
							{typing ? <span>{sc.prompt.slice(0, state.typed)}<i className="d-caret" /></span> : <span className="d-placeholder">Message Mob, or type / for commands</span>}
						</div>
						<div className="d-bar">
							<span className="d-model">claude-sonnet-5-5 ⌄</span>
							<button type="button" className="d-send" ref={refs.send} aria-label="Send" disabled={!typing} tabIndex={-1}><ArrowUpIcon /></button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function Telegram({ state, onDecide, refs }: { state: State; onDecide: (d: Decision) => void; refs: Record<Aim, RefObject<HTMLButtonElement | null>> }) {
	const sc = scenarios[state.scenario];
	const scroll = useRef<HTMLDivElement>(null);
	const approval = visible(state).find(v => v.step.kind === 'approve');
	const step = approval?.step.kind === 'approve' ? approval.step : undefined;
	const busy = state.phase === 'run' || state.phase === 'answer';
	const typing = state.phase === 'compose' && state.channel === 'telegram' && state.typed > 0;
	useLayoutEffect(() => {
		const el = scroll.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [state]);
	return (
		<div className="d-phone" aria-label="Mob on Telegram">
			<div className="tg-head">
				<span className="tg-back" aria-hidden="true">‹</span>
				<span className="tg-avatar"><Calf size={22} /></span>
				<div><b>Mob</b><small>{busy ? 'typing…' : 'bot'}</small></div>
			</div>
			<div className="tg-chat" ref={scroll}>
				<p className="tg-day">Today</p>
				<div className="tg-msg in"><p>Hi! Ask me anything, and I will check with you before I change something.</p><time>08:58</time></div>
				{state.phase !== 'compose' ? <div className="tg-msg out"><p>{sc.prompt}</p><time>09:02 ✓✓</time></div> : null}
				{step ? (
					<div className="tg-msg in">
						<p className="tg-pre">{step.telegram}</p>
						<time>09:02</time>
						{approval!.status === 'waiting' ? (
							<div className="tg-keys">
								<button type="button" ref={refs.approve} onClick={() => onDecide('allow')}>Approve</button>
								<button type="button" onClick={() => onDecide('always')}>Always</button>
								<button type="button" onClick={() => onDecide('deny')}>Deny</button>
							</div>
						) : <p className={`tg-decided${state.decision === 'deny' ? ' no' : ''}`}>{state.decision === 'deny' ? '✗ Denied' : state.decision === 'always' ? '✓ Always allowed' : '✓ Approved'}</p>}
					</div>
				) : null}
				{state.phase === 'done' ? <div className="tg-msg in fresh"><p>{briefOf(state)}</p><time>09:03</time></div> : null}
			</div>
			<div className="tg-compose">
				<span className={typing ? 'tg-typed' : 'tg-placeholder'}>{typing ? <>{sc.prompt.slice(0, state.typed)}<i className="d-caret" /></> : 'Message'}</span>
				<button type="button" ref={refs.send} aria-label="Send" disabled={!typing} tabIndex={-1}><ArrowUpIcon /></button>
			</div>
		</div>
	);
}

export function Demo() {
	const [still] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
	const [state, setState] = useState<State>(() => still ? finish(0) : start(0));
	// The autopilot drives until the visitor touches the demo.
	const [pilot, setPilot] = useState(!still);
	const [seen, setSeen] = useState(false);
	const [cursor, setCursor] = useState<{ x: number; y: number; press: boolean }>();
	const stage = useRef<HTMLDivElement>(null);
	const web = { send: useRef<HTMLButtonElement>(null), approve: useRef<HTMLButtonElement>(null) };
	const tg = { send: useRef<HTMLButtonElement>(null), approve: useRef<HTMLButtonElement>(null) };

	useEffect(() => {
		const el = stage.current;
		if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
		const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.35 });
		io.observe(el);
		return () => io.disconnect();
	}, []);

	// The clock: each state shows for its delay, then moves on.
	useEffect(() => {
		if (!seen || still) return;
		const ms = delay(state);
		if (ms === undefined) return;
		const t = setTimeout(() => setState(tick), ms);
		return () => clearTimeout(t);
	}, [state, seen, still]);

	const aim = useCallback((target: Aim, press: boolean) => {
		const refs = state.channel === 'telegram' ? tg : web;
		const el = refs[target].current, box = stage.current;
		if (!el || !box) return;
		const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
		setCursor({ x: r.left - b.left + r.width * 0.55, y: r.top - b.top + r.height * 0.6, press });
	}, [state.channel]);

	// The autopilot reaches for Send once the prompt is typed, Approve when
	// asked, and moves on to the next task a while after the answer.
	useEffect(() => {
		if (!pilot || !seen) return;
		const sc = scenarios[state.scenario];
		const timers: ReturnType<typeof setTimeout>[] = [];
		if (state.phase === 'compose' && state.typed >= sc.prompt.length) {
			aim('send', false);
			timers.push(setTimeout(() => aim('send', true), 300));
		} else if (state.phase === 'wait') {
			timers.push(setTimeout(() => aim('approve', false), AIM_AFTER));
			timers.push(setTimeout(() => aim('approve', true), AIM_AFTER + PRESS_AFTER));
			timers.push(setTimeout(() => setState(s => decide(s, 'allow')), AIM_AFTER + PRESS_AFTER + 160));
			// Then out of the way while the tool runs.
			timers.push(setTimeout(() => setCursor(c => c && { x: c.x + 140, y: c.y + 90, press: false }), AIM_AFTER + PRESS_AFTER + 600));
		} else if (state.phase === 'done') {
			timers.push(setTimeout(() => setState(start((state.scenario + 1) % scenarios.length)), NEXT_AFTER));
		}
		return () => timers.forEach(clearTimeout);
	}, [pilot, seen, state.phase, state.scenario, state.typed >= scenarios[state.scenario].prompt.length, aim]);
	useEffect(() => { if (cursor?.press) { const t = setTimeout(() => setCursor(c => c && { ...c, press: false }), 220); return () => clearTimeout(t); } }, [cursor?.press]);

	const takeOver = () => { if (pilot) { setPilot(false); setCursor(undefined); } };
	const pick = (i: number, channel?: Channel) => { takeOver(); setState(still ? finish(i, 'allow', channel) : start(i, channel)); };
	const choose = (d: Decision) => { takeOver(); setState(s => decide(s, d)); };
	const channel = (c: Channel) => pick(state.scenario, c);

	return (
		<section className="demo" id="demo" aria-labelledby="demo-title">
			<div className="demo-copy">
				<p className="demo-kicker">Live demo · nothing here calls a model</p>
				<h2 id="demo-title">Watch it run, then take over.</h2>
				<p>Recorded tasks, replayed in a copy of the app. Pick one, open a tool call to see what it did, and decide the approval yourself.</p>
			</div>
			<div className="demo-controls">
				<div className="demo-tasks" role="group" aria-label="Tasks">
					{scenarios.map((s, i) => <button type="button" key={s.title} aria-pressed={i === state.scenario} onClick={() => pick(i)}>{s.title}</button>)}
				</div>
				<div className="demo-channels" role="group" aria-label="Ask from">
					<span>Ask from</span>
					{(['web', 'telegram'] as Channel[]).map(c => (
						<button type="button" key={c} aria-pressed={state.channel === c} onClick={() => channel(c)}>{c === 'web' ? 'Web app' : 'Telegram'}</button>
					))}
				</div>
			</div>
			<div className="demo-stage" ref={stage} data-channel={state.channel} onClickCapture={takeOver}>
				<WebApp state={state} onPick={i => pick(i)} onDecide={choose} refs={web} />
				<Telegram state={state} onDecide={choose} refs={tg} />
				{pilot && cursor ? (
					<svg className={`demo-cursor${cursor.press ? ' press' : ''}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} width="22" height="22" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
						<path d="M1 1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1H8v1h1v2h1v2H8v-2H7v-2H6v1H5v1H4v1H1z" fill="#0a0d05" />
						<path d="M2 3h1v1h1v1h1v1h1v1h1v1h1v1h1v1H7v1h1v2H8v-1H7v-2H6v1H5v1H4v1H2z" fill="#f4f6ef" />
					</svg>
				) : null}
				{state.phase === 'done' && !pilot ? (
					<div className="demo-again">
						<button type="button" onClick={() => pick(state.scenario, state.channel)}>Replay</button>
						<button type="button" onClick={() => pick((state.scenario + 1) % scenarios.length)}>Next task →</button>
					</div>
				) : null}
			</div>
			<p className="demo-legend">
				{legend.map(([label, on], i) => <Fragment key={label}>{i ? <span aria-hidden="true">→</span> : null}<span className={on(state) ? 'on' : undefined}>{label}</span></Fragment>)}
			</p>
		</section>
	);
}

const legend: [string, (s: State) => boolean][] = [
	['You ask', s => s.phase === 'compose'],
	['Tools run', s => s.phase === 'run' && scenarios[s.scenario].steps[s.step]?.kind !== 'approve'],
	['It asks first', s => s.phase === 'wait' || (s.phase === 'run' && scenarios[s.scenario].steps[s.step]?.kind === 'approve')],
	['The answer comes back', s => s.phase === 'answer' || s.phase === 'done'],
];
