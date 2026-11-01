import { useEffect, useRef, useState } from 'react';
import { Content as DialogContent } from '@radix-ui/react-dialog';
import { Dialog, DialogDescription, DialogTitle, DialogTrigger } from '@mob/ui/dialog';
import { Button } from '@mob/ui/button';
import { api, ok, rpcOf, type ChatMessage, type Connection } from './api';
import type { ContextParts, ContextSnapshot, ConversationContext, UsageSummary } from './contracts';
import { AlertIcon, ArrowRightIcon, CompactIcon, InfoIcon } from './icons';
import { money as dollars, tokens } from './format';

/** warnAt and fullAt are the shares of the limit from which the meter turns amber, then red. */
export const warnAt = 75;
export const fullAt = 90;

// The prompt's parts, in the order they stack; the classes give each its colour.
const parts: { key: keyof ContextParts; label: string }[] = [
	{ key: 'system', label: 'Instructions & tools' },
	{ key: 'summary', label: 'Summary of earlier messages' },
	{ key: 'messages', label: 'Messages' },
	{ key: 'outputs', label: 'Tool outputs' },
];

/** liveContext is what the reply being written says its prompt takes, if it says. */
export function liveContext(messages: ChatMessage[]): ContextSnapshot | undefined {
	const last = messages.at(-1);
	if (last?.role !== 'assistant') return undefined;
	const part = last.parts.find((p) => p.type === 'data-context') as { data?: ContextSnapshot } | undefined;
	return part?.data;
}

/**
 * useContextUsage follows what the conversation's prompt takes of the window: the running
 * turn's own reports, and otherwise what Mob says the next turn would send. A turn's last
 * report stays shown until Mob's answer replaces it.
 */
export function useContextUsage(connection: Connection, id: string, messages: ChatMessage[], model: string, busy: boolean) {
	const live = liveContext(messages);
	const [shown, setShown] = useState<ContextSnapshot>();
	const [usage, setUsage] = useState<UsageSummary>();
	const running = useRef(live);
	running.current = live;
	useEffect(() => {
		if (live) setShown(live);
	}, [live]);
	const count = messages.length;
	useEffect(() => {
		if (busy) return;
		let current = true;
		ok(rpcOf(connection).conversations[':id'].context.$get({ param: { id } }))
			.then((r) => {
				if (!current) return;
				setUsage(r.usage);
				if (!running.current) setShown(r.context ?? undefined);
			})
			.catch(() => {
				/* the meter keeps what it showed */
			});
		return () => {
			current = false;
		};
	}, [connection, id, model, busy, count]);
	return { context: live ?? shown, usage };
}

/** share is the percentage of the limit context uses, or undefined when the window is unknown. */
export function share(context: ContextSnapshot) {
	return context.limit > 0 ? Math.round((context.used * 100) / context.limit) : undefined;
}

function level(percent?: number) {
	if (percent === undefined) return 'unknown';
	if (percent >= fullAt) return 'full';
	return percent >= warnAt ? 'warn' : '';
}

function Ring({ fraction }: { fraction?: number }) {
	const r = 6;
	const c = 2 * Math.PI * r;
	return (
		<svg className="context-ring" viewBox="0 0 16 16" aria-hidden="true">
			<circle className="context-ring-track" cx="8" cy="8" r={r} />
			{fraction === undefined ? (
				<circle className="context-ring-unknown" cx="8" cy="8" r={r} />
			) : (
				<circle
					className="context-ring-fill"
					cx="8"
					cy="8"
					r={r}
					strokeDasharray={`${(Math.min(fraction, 1) * c).toFixed(2)} ${c.toFixed(2)}`}
				/>
			)}
		</svg>
	);
}


/**
 * ContextMeter shows, beside Send, how much of the model's window the conversation's prompt
 * takes; it opens what the prompt is made of, and offers to compact it.
 */
export function ContextMeter({
	context,
	usage,
	busy,
	compact,
	openUsage,
}: {
	context?: ContextSnapshot;
	usage?: UsageSummary;
	busy: boolean;
	/** compact runs /compact; it returns false when the conversation cannot take a command now. */
	compact: () => boolean;
	openUsage?: () => void;
}) {
	const [open, setOpen] = useState(false);
	if (!context) return null;
	const percent = share(context);
	const state = level(percent);
	const label = percent === undefined ? `${tokens(context.used)} tokens` : `${percent}%`;
	const described =
		percent === undefined
			? `${tokens(context.used)} tokens of context; this model's window is unknown`
			: `${percent}% of context used: ${tokens(context.used)} of ${tokens(context.limit)} tokens`;
	return (
		<div className="context-anchor">
			<Dialog modal={false} open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					<button type="button" className={`context-meter ${state}`} aria-label={described} title={described}>
						<Ring fraction={percent === undefined ? undefined : context.used / context.limit} />
						<span className="context-label">{label}</span>
					</button>
				</DialogTrigger>
				{open && (
					<DialogContent className="context-details" onOpenAutoFocus={(e) => e.preventDefault()}>
						<span className="context-grab" aria-hidden="true" />
						<Details
							context={context}
							percent={percent}
							state={state}
							usage={usage}
							busy={busy}
							compact={() => {
								if (compact()) setOpen(false);
							}}
							openUsage={
								openUsage &&
								(() => {
									setOpen(false);
									openUsage();
								})
							}
						/>
					</DialogContent>
				)}
			</Dialog>
		</div>
	);
}

function Details({
	context,
	percent,
	state,
	usage,
	busy,
	compact,
	openUsage,
}: {
	context: ContextSnapshot;
	percent?: number;
	state: string;
	usage?: UsageSummary;
	busy: boolean;
	compact: () => void;
	openUsage?: () => void;
}) {
	const known = context.limit > 0;
	const free = Math.max(context.limit - context.used, 0);
	// What a prompt holds besides its messages is one part: instructions, saved facts and tool definitions.
	const values = context.parts ? { ...context.parts, system: context.parts.system + context.parts.tools } : undefined;
	// Messages always show; a part the prompt has none of does not.
	const rows = values ? parts.filter((p) => p.key === 'messages' || values[p.key] > 0) : [];
	const warn = state === 'warn' || state === 'full';
	let note = '';
	if (context.agent) note = 'Reported by the coding agent, which keeps its own context and compacts it itself.';
	else if (warn)
		note = `${percent! >= 100 ? 'Full' : 'Nearly full'}. The next turn summarizes older messages to make room; compact now to choose when.`;
	else if (context.summarized)
		note = `The first ${context.summarized} message${context.summarized === 1 ? ' is' : 's are'} read as a summary. Mob summarizes more when a turn would not fit.`;
	else if (context.omitted) note = 'Older messages are left out so the rest fits.';
	else if (!known) note = "This model's context window is unknown, so Mob sends the most recent messages.";
	return (
		<>
			<div className="context-top">
				<DialogTitle className="context-title">Context</DialogTitle>
				{percent !== undefined && <span className={`context-percent ${state}`}>{percent}%</span>}
			</div>
			<DialogDescription className="context-sub">
				{context.agent
					? `${tokens(context.used)} of ${tokens(context.window)} tokens in ${context.model}'s session`
					: known
						? `${tokens(context.used)} of ${tokens(context.limit)} tokens a turn can send`
						: `${tokens(context.used)} tokens a turn sends`}
			</DialogDescription>
			{known && (
				<div className="context-bar" role="img" aria-label={described(context, values)}>
					{values ? (
						rows.map((p) =>
							values[p.key] > 0 ? <span key={p.key} className={`context-${p.key}`} style={{ flexGrow: values[p.key] }} /> : null,
						)
					) : (
						<span className="context-messages" style={{ flexGrow: context.used }} />
					)}
					{free > 0 && <span className="context-free" style={{ flexGrow: free }} />}
					{context.reserve > 0 && <span className="context-reserve" style={{ flexGrow: context.reserve }} />}
				</div>
			)}
			{(values || known) && (
				<dl className="context-legend">
					{values &&
						rows.map((p) => (
							<div key={p.key}>
								<dt>
									<span className={`context-swatch context-${p.key}`} />
									{p.label}
									{p.key === 'system' && context.tools ? <small> · {context.tools} tools</small> : null}
								</dt>
								<dd>{tokens(values[p.key])}</dd>
							</div>
						))}
					{!values && known && (
						<div>
							<dt>
								<span className="context-swatch context-messages" />
								In use
							</dt>
							<dd>{tokens(context.used)}</dd>
						</div>
					)}
					{known && (
						<div className="context-quiet">
							<dt>
								<span className="context-swatch context-free" />
								Free
							</dt>
							<dd>{tokens(free)}</dd>
						</div>
					)}
					{context.reserve > 0 && (
						<div className="context-quiet">
							<dt>
								<span className="context-swatch context-reserve" />
								Kept for the reply<small> · window {tokens(context.window)}</small>
							</dt>
							<dd>{tokens(context.reserve)}</dd>
						</div>
					)}
				</dl>
			)}
			{note && (
				<p className={`context-note${warn ? ' warn' : ''}`}>
					{warn ? <AlertIcon /> : <InfoIcon />}
					<span>{note}</span>
				</p>
			)}
			<div className="context-actions">
				{!context.agent && (
					<Button
						type="button"
						variant="outline"
						className="context-compact"
						disabled={busy}
						onClick={compact}
						title={busy ? 'Wait for the current turn to finish' : 'Summarize the conversation so far (/compact)'}
					>
						<CompactIcon /> Compact now
					</Button>
				)}
				<span className="context-source">{context.measured ? 'Measured at the last reply' : 'Estimated'}</span>
			</div>
			{usage && usage.totalTokens > 0 && (
				<div className="context-foot">
					<span>
						This conversation: {tokens(usage.totalTokens)} tokens{usage.cost > 0 ? ` · ${dollars(usage.cost)}` : ''}
					</span>
					{openUsage && (
						<button type="button" className="context-usage-link" onClick={openUsage}>
							Token usage <ArrowRightIcon />
						</button>
					)}
				</div>
			)}
		</>
	);
}

function described(context: ContextSnapshot, values?: ContextParts) {
	const list = values
		? parts.filter((p) => values[p.key] > 0).map((p) => `${p.label} ${tokens(values[p.key])}`)
		: [`In use ${tokens(context.used)}`];
	list.push(`Free ${tokens(Math.max(context.limit - context.used, 0))}`);
	if (context.reserve > 0) list.push(`Kept for the reply ${tokens(context.reserve)}`);
	return list.join(', ');
}
