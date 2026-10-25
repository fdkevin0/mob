import { useState } from 'react';
import { Content as DialogContent } from '@radix-ui/react-dialog';
import { Dialog, DialogDescription, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import type { ChatMessage, ReplyStats, ReplyUsage } from './api';
import { BrandIcon, modelBrand } from './brandIcons';
import { seconds, tokens } from './format';

/** modelName is how a reply's model reads: its ID without the provider or reasoning level. */
export function modelName(model: string) {
	const id = model.slice(model.indexOf('/') + 1);
	const colon = id.lastIndexOf(':');
	return colon > 0 && /^(none|minimal|low|medium|high|xhigh|max)$/.test(id.slice(colon + 1)) ? id.slice(0, colon) : id;
}

/** speed is how many output tokens a second the reply's model wrote, once it had started, when that was measured. */
export function speed(stats?: ReplyStats) {
	if (!stats?.generationMs || !stats.timedOutput) return undefined;
	return (stats.timedOutput * 1000) / stats.generationMs;
}

const rate = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} tok/s`;
const total = (u: ReplyUsage) => u.inputTokens + u.outputTokens;
const dollars = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

/**
 * ReplyMeta says, under a reply, which model wrote it, the tokens it took and
 * how fast the model wrote; it opens what the reply used and where its time went.
 * While the reply is written it names the model only.
 */
export function ReplyMeta({ message, live }: { message: ChatMessage; live: boolean }) {
	const [open, setOpen] = useState(false);
	const { model, usage, stats } = message.metadata ?? {};
	if (!model && !usage) return null;
	const brand = model ? modelBrand(model, model) : undefined;
	const name = model ? modelName(model) : 'Reply';
	const perSecond = speed(stats);
	const label = live ? [name] : [name, usage && `${tokens(total(usage))} tokens`, perSecond !== undefined && rate(perSecond)].filter(Boolean);
	const summary = label.join(' · ');
	if (live || !usage)
		return (
			<span className="reply-meta quiet" title={model}>
				{brand && <BrandIcon brand={brand} size={14} />}
				{summary}
			</span>
		);
	return (
		<div className="reply-meta-anchor">
			<Dialog modal={false} open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					<button type="button" className="reply-meta" aria-label={`Reply details: ${summary}`} title={model}>
						{brand && <BrandIcon brand={brand} size={14} />}
						{label.map((part, i) => (
							<span key={i}>
								{i > 0 && <span className="reply-meta-dot">·</span>}
								{part}
							</span>
						))}
					</button>
				</DialogTrigger>
				{open && (
					<DialogContent className="reply-details" onOpenAutoFocus={(e) => e.preventDefault()}>
						<ReplyDetails model={model} usage={usage} stats={stats} perSecond={perSecond} />
					</DialogContent>
				)}
			</Dialog>
		</div>
	);
}

function ReplyDetails({ model, usage, stats, perSecond }: { model?: string; usage: ReplyUsage; stats?: ReplyStats; perSecond?: number }) {
	const brand = model ? modelBrand(model, model) : undefined;
	const slash = model?.indexOf('/') ?? -1;
	const provider = model && slash > 0 ? model.slice(0, slash) : '';
	const id = model ? model.slice(slash + 1) : '';
	const effort = model && id !== modelName(model) ? id.slice(modelName(model).length + 1) : '';
	const took = stats?.finishedAt ? stats.finishedAt - stats.startedAt : undefined;
	const when = stats?.finishedAt ? new Date(stats.finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
	const cached = usage.cacheReadTokens ?? 0;
	// Where the reply's time went: waiting for the first words, writing, running tools, and the rest.
	const spans = took
		? [
				{ key: 'first', label: 'First token', ms: Math.min(stats?.firstTokenMs ?? 0, took) },
				{ key: 'writing', label: 'Writing', ms: stats?.generationMs ?? 0 },
				{ key: 'tools', label: 'Tools', ms: stats?.toolMs ?? 0 },
			].filter((s) => s.ms > 0)
		: [];
	const other = took ? Math.max(took - spans.reduce((sum, s) => sum + s.ms, 0), 0) : 0;
	// What is left is shown once it is long enough to read as more than rounding.
	if (took && other >= 100 && spans.length) spans.push({ key: 'other', label: 'Other', ms: other });
	const rows: [string, string][] = [];
	if (cached > 0) rows.push(['Cache read', `${tokens(cached)} (${Math.round((cached * 100) / Math.max(usage.inputTokens, 1))}%)`]);
	if (usage.cacheWriteTokens) rows.push(['Cache write', tokens(usage.cacheWriteTokens)]);
	if (usage.reasoningTokens) rows.push(['Reasoning tokens', tokens(usage.reasoningTokens)]);
	if (stats?.requests) rows.push(['Model requests', String(stats.requests)]);
	if (took !== undefined) rows.push(['Total time', seconds(took)]);
	if (usage.cost) rows.push(['Cost', dollars(usage.cost)]);
	return (
		<>
			<div className="reply-details-top">
				{brand && <BrandIcon brand={brand} size={20} />}
				<div>
					<DialogTitle className="reply-details-title">{model ? modelName(model) : 'Reply'}</DialogTitle>
					<DialogDescription className="reply-details-sub">{[provider, effort && `reasoning ${effort}`].filter(Boolean).join(' · ') || 'What this reply used'}</DialogDescription>
				</div>
				{when && <time className="reply-details-time">{when}</time>}
			</div>
			<dl className="reply-tiles">
				<div>
					<dt>Input</dt>
					<dd>{tokens(usage.inputTokens)}</dd>
				</div>
				<div>
					<dt>Output</dt>
					<dd>{tokens(usage.outputTokens)}</dd>
				</div>
				<div>
					<dt>{perSecond !== undefined ? 'Speed' : 'Time'}</dt>
					<dd>{perSecond !== undefined ? rate(perSecond) : took !== undefined ? seconds(took) : '—'}</dd>
				</div>
			</dl>
			{spans.length > 0 && (
				<>
					<div className="reply-time-bar" aria-hidden="true">
						{spans.map((s) => (
							<span key={s.key} className={`reply-time-${s.key}`} style={{ flexGrow: s.ms }} />
						))}
					</div>
					<ul className="reply-time-legend">
						{spans.map((s) => (
							<li key={s.key}>
								<span className={`reply-swatch reply-time-${s.key}`} />
								{s.label} <span className="reply-time-value">{seconds(s.ms)}</span>
							</li>
						))}
					</ul>
				</>
			)}
			{rows.length > 0 && (
				<dl className="reply-rows">
					{rows.map(([label, value]) => (
						<div key={label}>
							<dt>{label}</dt>
							<dd>{value}</dd>
						</div>
					))}
				</dl>
			)}
		</>
	);
}
