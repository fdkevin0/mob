import { useEffect, useMemo, useState } from 'react';
import { api, type Connection } from './api';
import { Loading } from './Splash';
import { tokens } from './format';
export { tokens } from './format';
import type { DayUsage, UsageReport } from './contracts';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Notice } from '../components/ui/notice';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const periods = [
	{ days: 7, label: '7 days' },
	{ days: 30, label: '30 days' },
	{ days: 0, label: 'All time' },
] as const;

type Counts = Pick<DayUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;

// The parts every token falls into, in stacking order; input counts the cache, so fresh input is what is left.
const parts = [
	{ key: 'fresh', label: 'Input', hint: 'not cached', value: (u: Counts) => Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens) },
	{ key: 'read', label: 'Cache read', hint: 'input read from the cache', value: (u: Counts) => u.cacheReadTokens },
	{ key: 'write', label: 'Cache write', hint: 'input written to the cache', value: (u: Counts) => u.cacheWriteTokens },
	{ key: 'output', label: 'Output', hint: 'reasoning included', value: (u: Counts) => u.outputTokens },
] as const;

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : '—');
const dollars = (n: number) => (n > 0 ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : '—');
function duration(ms: number) {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Every day the report spans gets a column, so quiet days show as gaps. Days
// are the service's calendar days, which need not be this browser's.
export function fillDays(days: DayUsage[], first: string, last: string): DayUsage[] {
	if (!first || !last) return days;
	const byDate = new Map(days.map((d) => [d.date, d]));
	const empty = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, durationMs: 0, requests: 0 };
	const list: DayUsage[] = [];
	// Counting in UTC keeps each step one calendar day, whatever this browser's zone.
	for (let d = new Date(`${first}T00:00:00Z`), end = new Date(`${last}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
		const date = d.toISOString().slice(0, 10);
		list.push(byDate.get(date) ?? { date, ...empty });
	}
	return list;
}

export function Usage({
	connection,
	open,
	held,
}: {
	connection: Connection;
	open: (id: string) => void;
	/** held says which conversations cannot open now, while the open one hands a message to Mob. */
	held?: (id: string) => boolean;
}) {
	const [period, setPeriod] = useState<number>(30);
	const [report, setReport] = useState<UsageReport>();
	const [error, setError] = useState('');

	useEffect(() => {
		let live = true;
		setError('');
		api<UsageReport>(connection, `/usage?days=${period}`)
			.then((r) => live && setReport(r))
			.catch((e) => live && setError(errorText(e)));
		return () => {
			live = false;
		};
	}, [connection, period]);

	return (
		<section className="page" aria-label="Token usage">
			<header className="view-header">
				<div className="view-header-inner wide">
					<h1>Token usage</h1>
				</div>
			</header>
			<div className="plugins usage">
			<Tabs value={String(period)} onValueChange={(v) => setPeriod(Number(v))}>
				<TabsList aria-label="Period">
					{periods.map((p) => (
						<TabsTrigger key={p.days} value={String(p.days)}>
							{p.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			{error && <Notice tone="error">{error}</Notice>}
			{!report ? (
				!error && <Loading label="Counting tokens…" />
			) : report.totalTokens === 0 ? (
				<p>No tokens were used in this period. Replies and coding agent tasks count here once they finish.</p>
			) : (
				<Report report={report} open={open} held={held} />
			)}
			</div>
		</section>
	);
}

function Report({ report, open, held }: { report: UsageReport; open: (id: string) => void; held?: (id: string) => boolean }) {
	const days = useMemo(() => fillDays(report.days, report.firstDay, report.lastDay), [report]);
	const top = Math.max(...report.models.map((m) => m.totalTokens), 1);
	return (
		<>
			<section className="usage-tiles" aria-label="Totals">
				<Tile label="Tokens" value={tokens(report.totalTokens)} detail={`${report.requests} requests · ${report.turns} replies · ${report.conversations} conversations`} />
				<Tile label="Read from cache" value={percent(report.cacheReadTokens, report.inputTokens)} detail={`${tokens(report.cacheReadTokens)} of ${tokens(report.inputTokens)} input`} />
				<Tile label="Cost" value={dollars(report.cost)} detail="at list price; subscriptions are not charged it" />
				<Tile label="Model time" value={duration(report.durationMs)} detail={`${tokens(report.reasoningTokens)} reasoning tokens`} />
			</section>

			<h2>Where tokens go</h2>
			<Composition usage={report} />

			<h2>By day</h2>
			<Daily days={days} />

			<h2>By model</h2>
			<table className="usage-table">
				<thead>
					<tr>
						<th scope="col">Model</th>
						<th scope="col" className="usage-share-head">
							Tokens
						</th>
						<th scope="col">Cached</th>
						<th scope="col">Output</th>
						<th scope="col">Requests</th>
						<th scope="col">Cost</th>
					</tr>
				</thead>
				<tbody>
					{report.models.map((m) => (
						<tr key={m.model}>
							<th scope="row">
								<code>{m.model || 'unknown'}</code>
							</th>
							<td className="usage-share">
								<span className="usage-bar" style={{ width: `${(m.totalTokens * 100) / top}%` }} />
								<span>{tokens(m.totalTokens)}</span>
							</td>
							<td>{percent(m.cacheReadTokens, m.inputTokens)}</td>
							<td>{tokens(m.outputTokens)}</td>
							<td>{m.requests}</td>
							<td>{dollars(m.cost)}</td>
						</tr>
					))}
				</tbody>
			</table>

			<h2>Top conversations</h2>
			<table className="usage-table">
				<thead>
					<tr>
						<th scope="col">Conversation</th>
						<th scope="col">Tokens</th>
						<th scope="col">Cached</th>
						<th scope="col">Replies</th>
						<th scope="col">Cost</th>
					</tr>
				</thead>
				<tbody>
					{report.top.map((c) => (
						<tr key={c.id}>
							<th scope="row">
								{c.deleted ? (
									<span className="usage-deleted">Deleted conversation</span>
								) : (
									<button type="button" className="usage-link" disabled={held?.(c.id)} onClick={() => open(c.id)}>
										{c.title || 'Untitled'}
									</button>
								)}
								{c.agent && <span className="usage-agent">task · {c.agent}</span>}
							</th>
							<td>{tokens(c.totalTokens)}</td>
							<td>{percent(c.cacheReadTokens, c.inputTokens)}</td>
							<td>{c.turns}</td>
							<td>{dollars(c.cost)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	);
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
	return (
		<div className="usage-tile">
			<span>{label}</span>
			<strong>{value}</strong>
			<small>{detail}</small>
		</div>
	);
}

function Legend() {
	return (
		<ul className="usage-legend" aria-label="Legend">
			{parts.map((p) => (
				<li key={p.key}>
					<span className={`usage-swatch usage-${p.key}`} />
					{p.label}
				</li>
			))}
		</ul>
	);
}

// Composition is one bar split into the parts of every token used.
function Composition({ usage }: { usage: Counts & { totalTokens: number } }) {
	const total = Math.max(usage.totalTokens, 1);
	return (
		<div className="usage-composition">
			<div className="usage-stack" role="img" aria-label={parts.map((p) => `${p.label} ${percent(p.value(usage), total)}`).join(', ')}>
				{parts.map((p) => {
					const v = p.value(usage);
					return v > 0 ? (
						<span key={p.key} className={`usage-${p.key}`} style={{ flexGrow: v }} title={`${p.label}: ${tokens(v)} (${percent(v, total)})`} />
					) : null;
				})}
			</div>
			<dl className="usage-parts">
				{parts.map((p) => (
					<div key={p.key}>
						<dt>
							<span className={`usage-swatch usage-${p.key}`} />
							{p.label}
						</dt>
						<dd>
							{tokens(p.value(usage))} <small>{percent(p.value(usage), total)}</small>
						</dd>
						<dd className="usage-hint">{p.hint}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

// Daily stacks each day's tokens by part; hovering a day shows its numbers.
function Daily({ days }: { days: DayUsage[] }) {
	const [hover, setHover] = useState<number>();
	const max = Math.max(...days.map((d) => d.totalTokens), 1);
	const width = 720;
	const height = 180;
	const step = width / Math.max(days.length, 1);
	const bar = Math.max(2, Math.min(28, step - 2));
	const shown = hover === undefined ? undefined : days[hover];
	const label = (date: string) => date.slice(5).replace('-', '/');
	return (
		<div className="usage-daily">
			<Legend />
			<div className="usage-plot">
				<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Tokens per day, highest ${tokens(max)}`} onMouseLeave={() => setHover(undefined)}>
					{days.map((d, i) => {
						let y = height;
						const x = i * step + (step - bar) / 2;
						return (
							<g key={d.date} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={d.totalTokens ? 0 : -1} aria-label={`${d.date}: ${tokens(d.totalTokens)} tokens`}>
								<rect x={i * step} y="0" width={step} height={height} className="usage-hit" />
								{parts.map((p, j) => {
									const h = (p.value(d) / max) * height;
									if (h <= 0) return null;
									y -= h;
									// A 2px gap separates the stacked parts.
									const gap = j > 0 && h > 3 ? 2 : 0;
									return <rect key={p.key} x={x} y={y} width={bar} height={Math.max(h - gap, 1)} className={`usage-${p.key}`} />;
								})}
							</g>
						);
					})}
				</svg>
				{days.length > 1 && (
					<div className="usage-ticks" aria-hidden="true">
						<span>{label(days[0].date)}</span>
						<span>{label(days[Math.floor((days.length - 1) / 2)].date)}</span>
						<span>{label(days[days.length - 1].date)}</span>
					</div>
				)}
				{shown && (
					<div className="usage-tooltip" role="status" style={{ left: `${(((hover ?? 0) + 0.5) * 100) / days.length}%` }}>
						<strong>{shown.date}</strong>
						{parts.map((p) => (
							<span key={p.key}>
								<i className={`usage-swatch usage-${p.key}`} />
								{p.label} <b>{tokens(p.value(shown))}</b>
							</span>
						))}
						<span>
							Total <b>{tokens(shown.totalTokens)}</b>
							{shown.cost > 0 && ` · ${dollars(shown.cost)}`}
						</span>
					</div>
				)}
			</div>
		</div>
	);
}
