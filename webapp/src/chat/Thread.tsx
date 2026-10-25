import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { isToolUIPart } from 'ai';
import type { Changes } from '@mob/client';
import { useConversation } from './useConversation';
import { useCompletion } from './useCompletion';
import {
	Conversation as ChatConversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from '../components/ai-elements/conversation';
import { JsonResponse, Message, MessageContent, MessageResponse } from '../components/ai-elements/message';
import { Button } from '../components/ui/button';
import { ApprovalPrompt } from './ApprovalPrompt';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogTrigger } from '../components/ui/dialog';
import { api, type ChatMessage, type Connection, type Snapshot } from './api';
import type { Action } from './contracts';
import { ModelPicker } from './ModelPicker';
import { ReplyMeta, modelName } from './ReplyMeta';
import { BrandIcon, modelBrand } from './brandIcons';
import { ContextMeter, useContextUsage } from './ContextMeter';
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronIcon, CopyIcon, CrossIcon, HandIcon, RaisedHandIcon, RenameIcon, RetryIcon, SpinnerIcon, StopIcon } from './icons';

// What a new conversation offers to start with; a choice fills the message box, and nothing is sent until the owner sends it.
const starters = [
	{ label: 'Fix a bug with Codex', text: 'Ask Codex to find and fix the failing tests in my project', runner: true },
	{ label: 'Remember something', text: 'Remember that I prefer short answers' },
	{ label: 'Summarize a web page', text: 'Summarize this page: ', runner: true },
	{ label: 'Explain some code', text: 'Explain what this code does:\n\n' },
	{ label: 'Plan my week', text: 'Help me plan my week. This week I need to ' },
];


export function Thread({
	connection,
	id,
	initial,
	initialInput,
	title,
	onDispatching,
	onChanged,
	onAction,
	onLeave,
	changes,
	draft,
	clearDraft,
	addProvider,
	openUsage,
}: {
	connection: Connection;
	id: string;
	initial: Snapshot;
	initialInput?: string;
	title?: string;
	/** onDispatching hears whether a message, command or decision is still on its way to Mob. */
	onDispatching?: (dispatching: boolean) => void;
	onChanged: () => void;
	onAction: (action: Action) => void;
	onLeave?: (snapshot: Snapshot, input: string) => void;
	changes?: Changes;
	/** draft is a prompt chosen on another page, such as an example in Agents. */
	draft?: string;
	clearDraft?: () => void;
	/** addProvider opens the Model provider dialog from the model picker. */
	addProvider?: () => void;
	/** openUsage shows the Token usage page. */
	openUsage?: () => void;
}) {
	const {
		model,
		input,
		setInput,
		remoteBusy,
		approvalBusy,
		failure,
		messages,
		streaming,
		busy,
		error,
		submit,
		run,
		proceed,
		resend,
		decide,
		cancel,
		commandResult,
		dismissCommand,
		dispatching,
		setModel,
	} = useConversation({ connection, id, initial, initialInput, onChanged, onAction, onLeave, changes });
	useEffect(() => {
		onDispatching?.(dispatching);
		return () => onDispatching?.(false);
	}, [dispatching, onDispatching]);
	// The header says when Mob replies here or waits for a decision, as the sidebar does.
	const waiting = messages.some((m) => m.parts.some((p) => isToolUIPart(p) && p.state === 'approval-requested'));
	// Working… shows only while nothing else says Mob is at work: before the reply's first words, while it reasons, and between a
	// tool's result and what Mob does next. Streaming text and a running tool's spinner say it themselves.
	const working = busy && !quiet(messages.at(-1));
	const composer = useRef<HTMLDivElement>(null);
	const unseen = useUnseenApproval(composer, waiting, messages);
	useEffect(() => {
		if (!draft) return;
		setInput(draft);
		clearDraft?.();
	}, []);
	const completion = useCompletion({ connection, id, input, setInput });
	const context = useContextUsage(connection, id, messages, model, busy);
	const [choosing, setChoosing] = useState(false);
	const [defaultModel, setDefaultModel] = useState<string>();
	const live = useRef(true);
	const loadDefault = useCallback(() => {
		api<{ defaultModel?: string }>(connection, '/config')
			.then((config) => {
				if (live.current) setDefaultModel(config.defaultModel);
			})
			.catch(() => {
				/* the header stays usable without the default model */
			});
	}, [connection]);
	useEffect(() => {
		live.current = true;
		loadDefault();
		return () => {
			live.current = false;
		};
	}, [loadDefault]);
	const demo = model?.startsWith('demo/');
	// A model shows by its name, with its provider in the tooltip and its family's logo.
	const effort = model && !demo ? model.slice(model.indexOf('/') + 1).slice(modelName(model).length + 1) : '';
	const modelLabel = demo ? 'Demo mode · no model calls' : model ? modelName(model) : 'Connecting…';
	const brand = model && !demo ? modelBrand(model, '') : undefined;
	const empty = messages.length === 0 && !busy;
	const textarea = useRef<HTMLTextAreaElement>(null);
	// The message box grows with its text up to a limit, then scrolls.
	useLayoutEffect(() => {
		const box = textarea.current;
		if (!box) return;
		box.style.height = 'auto';
		box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
	}, [input]);
	return (
		<>
			<header className="view-header thread-header">
				<div className="view-header-inner">
					<h1>{title || 'New conversation'}</h1>
					{waiting ? (
						<span className="thread-status waiting">
							<RaisedHandIcon /> Waiting for you
						</span>
					) : (
						busy && (
							<span className="thread-status running">
								<span className="run-dot" /> Replying
							</span>
						)
					)}
				</div>
			</header>
			<ChatConversation className="conversation">
				<ConversationContent className="conversation-content">
					{empty && (
						<ConversationEmptyState
							className="empty-state thread-empty"
							title="What’s on your mind?"
							description="Ask a question, explore an idea, or save something to remember."
						/>
					)}
					{messages.map((message, index) => (
						<MessageView
							key={message.id}
							message={message}
							animating={streaming && index === messages.length - 1}
							last={index === messages.length - 1}
							busy={busy}
							decide={decide}
							proceed={proceed}
							resend={resend}
							asked={index === messages.length - 1 ? askedBy(messages) : undefined}
						/>
					))}
					{busy && remoteBusy && !streaming && !approvalBusy ? (
						<p className="thinking" role="status">
							A turn is running in another client…
						</p>
					) : (
						working && (
							<p className="thinking" role="status">
								Working…
							</p>
						)
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</ChatConversation>
			<div className="composer-area" ref={composer}>
				{unseen && (
					<button type="button" className="approval-bar" onClick={() => unseen.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
						<RaisedHandIcon /> Mob is waiting for your approval
						<span>Review</span>
					</button>
				)}
				{(failure || error) && (
					<p className="error" role="alert">
						{failure || error?.message}
					</p>
				)}
				{commandResult && (
					<section className="command-result" aria-label="Command result">
						<MessageResponse>{commandResult}</MessageResponse>
						<Button variant="ghost" onClick={dismissCommand}>
							Dismiss
						</Button>
					</section>
				)}
				{completion.suggestions.length > 0 && (
					<ul className="suggestions" id="command-suggestions" role="listbox" aria-label="Command suggestions">
						{completion.suggestions.map((s, i) => (
							<li
								key={`${i}-${s.value}`}
								id={`suggestion-${i}`}
								role="option"
								aria-selected={i === completion.selected}
								onMouseDown={(e) => {
									e.preventDefault();
									completion.accept(i);
								}}
							>
								<CommandLabel label={s.label} />
								{s.detail && <small>{s.detail}</small>}
							</li>
						))}
					</ul>
				)}
				<form className="composer" onSubmit={submit}>
					<Label className="sr-only" htmlFor="message">
						Message
					</Label>
					<Textarea
						ref={textarea}
						id="message"
						placeholder="Message Mob, or type / for commands"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						rows={1}
						aria-autocomplete="list"
						aria-controls={completion.suggestions.length ? 'command-suggestions' : undefined}
						aria-activedescendant={completion.suggestions.length ? `suggestion-${completion.selected}` : undefined}
						onKeyDown={(e) => {
							if (completion.onKeyDown(e)) return;
							if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								e.currentTarget.form?.requestSubmit();
							}
						}}
					/>
					<div className="composer-bar">
						<div className="model-picker-anchor">
							<Dialog modal={false} open={choosing} onOpenChange={setChoosing}>
								<DialogTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										className="model-button"
										aria-label={model && !demo ? model : undefined}
										aria-haspopup="dialog"
										aria-expanded={choosing}
										title={`${model && !demo ? model + ' · ' : ''}This conversation's model; a new choice applies from the next reply`}
									>
										{brand && <BrandIcon brand={brand} size={14} />}
										<span className="model-label">{modelLabel}</span>
										{effort && <span className="model-effort-tag">{effort}</span>}
										<ChevronDownIcon />
									</Button>
								</DialogTrigger>
								{choosing && (
									<ModelPicker
										connection={connection}
										current={model}
										defaultModel={defaultModel}
										setDefault={
											busy
												? undefined
												: (ref) => {
														// The default shown is the one the service has once the command has run, saved or not.
														const done = run(`/model default ${ref}`);
														if (done) void done.then(loadDefault);
													}
										}
										onPick={(choice) => {
											void setModel(choice ?? '').then((saved) => {
												if (saved) setChoosing(false);
											});
										}}
										addProvider={
											addProvider &&
											(() => {
												setChoosing(false);
												addProvider();
											})
										}
									/>
								)}
							</Dialog>
						</div>
						<div className="composer-actions">
							<ContextMeter
								context={context.context}
								usage={context.usage}
								busy={busy}
								compact={() => run('/compact') !== false}
								openUsage={openUsage}
							/>
							{busy ? (
								<Button type="button" className="send-button" aria-label="Stop" title="Stop" onClick={() => void cancel()}>
									<StopIcon />
								</Button>
							) : (
								<Button className="send-button" aria-label="Send" title="Send (Enter)" disabled={!input.trim()}>
									<ArrowUpIcon />
								</Button>
							)}
						</div>
					</div>
				</form>
				{empty && !input && (
					<ul className="starters" aria-label="Ways to start">
						{starters
							.filter((s) => !s.runner || !connection.browser)
							.slice(0, 4)
							.map((s) => (
								<li key={s.label}>
									<button
										type="button"
										onClick={() => {
											setInput(s.text);
											textarea.current?.focus();
										}}
									>
										{s.label}
									</button>
								</li>
							))}
					</ul>
				)}
			</div>
		</>
	);
}

// CommandLabel shows a command's name as typed, and its arguments as a quieter hint.
function CommandLabel({ label }: { label: string }) {
	const space = label.indexOf(' ');
	if (space < 0) return <span className="command-name">{label}</span>;
	return (
		<span className="command-name">
			{label.slice(0, space)}
			<span className="command-args">{label.slice(space)}</span>
		</span>
	);
}

// quiet reports whether the end of a reply already shows Mob at work, or waiting: words arriving, a tool running or asking.
// Reasoning is not quiet: it streams inside a closed Reasoning row, which looks the same whether it moves or not.
export function quiet(last: ChatMessage | undefined) {
	if (last?.role !== 'assistant') return false;
	const part = last.parts.at(-1);
	if (!part) return false;
	if (isToolUIPart(part)) return !part.state.startsWith('output-');
	return part.type === 'text';
}

// useUnseenApproval finds the approval card Mob waits on while it is scrolled out of view, so the composer can point to it.
function useUnseenApproval(composer: RefObject<HTMLDivElement | null>, waiting: boolean, messages: ChatMessage[]) {
	const [unseen, setUnseen] = useState<HTMLElement>();
	useEffect(() => {
		setUnseen(undefined);
		// The card is in the thread the composer belongs to.
		const card = waiting ? composer.current?.parentElement?.querySelector<HTMLElement>('.tool-call.waiting') : null;
		if (!card || typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver(([entry]) => setUnseen(entry.isIntersecting ? undefined : card));
		observer.observe(card);
		return () => observer.disconnect();
	}, [composer, waiting, messages]);
	return unseen;
}

type Decide = (approvalId: string, approved: boolean, reason?: string, remember?: string) => Promise<void> | void;
type Resend = (id: string, text: string) => Promise<void> | void;

// askedBy is the owner's message the last reply answers, which retrying says again; commands and their replies are not retried.
export function askedBy(messages: ChatMessage[]): ChatMessage | undefined {
	const [reply, asked] = messages.slice(-2).reverse();
	if (reply?.role !== 'assistant' || asked?.role !== 'user' || reply.metadata?.command || asked.metadata?.command) return undefined;
	return asked;
}
const textOf = (message: ChatMessage) =>
	message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n\n');

// MessageView renders one message. It is memoized so that streaming a reply re-renders only that reply,
// not the whole history: the client keeps unchanged messages as the same objects.
const MessageView = memo(function MessageView({
	message,
	animating,
	last,
	busy,
	decide,
	proceed,
	resend,
	asked,
}: {
	message: ChatMessage;
	animating: boolean;
	last: boolean;
	busy: boolean;
	decide: Decide;
	proceed: () => void;
	resend: Resend;
	/** asked is the owner's message this reply answers, when it is the last reply and can be asked for again. */
	asked?: ChatMessage;
}) {
	const [editing, setEditing] = useState(false);
	const user = message.role === 'user';
	if (editing)
		return (
			<Message from={message.role}>
				<MessageEditor
					text={textOf(message)}
					cancel={() => setEditing(false)}
					send={(text) => {
						setEditing(false);
						void resend(message.id, text);
					}}
				/>
			</Message>
		);
	return (
		<Message from={message.role}>
			<p className="sr-only">{message.role === 'user' ? 'You' : 'Mob'}</p>
			<MessageContent className={message.role === 'user' ? 'user-bubble' : 'assistant-content'}>
				{message.parts.map((part, index) => {
					if (part.type === 'text' && message.role === 'user') return <UserText key={index} text={part.text} />;
					if (part.type === 'text')
						return (
							<MessageResponse key={index} isAnimating={animating}>
								{part.text}
							</MessageResponse>
						);
					if (part.type === 'reasoning')
						return (
							<details className="reasoning" key={index}>
								<summary>
									<ChevronIcon /> Reasoning
								</summary>
								<MessageResponse className="reasoning-content" isAnimating={animating}>{part.text}</MessageResponse>
							</details>
						);
					if (isToolUIPart(part)) {
						const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
						const state = toolState(part.state);
						return (
							<details
								className={`tool-call ${state.kind}`}
								key={part.toolCallId}
								open={state.kind === 'waiting' || state.kind === 'failed'}
							>
								<summary onClick={state.kind === 'waiting' ? (e) => e.preventDefault() : undefined}>
									<span className="tool-status" title={state.label}>
										{state.icon}
									</span>
									<span className="tool-title">{toolTitle(name)}</span>
									<span className="tool-detail">{toolDetail(part.input)}</span>
									<span className="sr-only">{state.label}</span>
									<ChevronIcon />
								</summary>
								{part.state !== 'approval-requested' && <div className="tool-body">
									<JsonResponse value={part.input} />
									{part.state === 'output-available' && <JsonResponse value={part.output} />}
									{part.state === 'output-error' && <p role="alert">{part.errorText}</p>}
								</div>}
								{part.state === 'approval-requested' && (
									<ApprovalPrompt
										question={
											name === 'remember' ? 'Mob wants to save this to memory.' : `Mob wants to use ${toolTitle(name).toLowerCase()}.`
										}
										request={JSON.stringify(part.input, null, 2) ?? ''}
										busy={busy}
										decide={(approved, reason, remember) => void decide(part.approval.id, approved, reason, remember)}
									/>
								)}
							</details>
						);
					}
					return null;
				})}
				{message.metadata?.status === 'step-limit' ? (
					<div className="step-limit">
						<p className="muted" role="status">
							Stopped after reaching the tool step limit.
						</p>
						{last && !busy && (
							<Button variant="outline" onClick={proceed}>
								Continue
							</Button>
						)}
					</div>
				) : (
					message.metadata?.error && (
						<p className="error" role="status">
							{message.metadata.status}: {message.metadata.error}
						</p>
					)
				)}
			</MessageContent>
			{!user && !message.metadata?.command && (message.metadata?.model || message.metadata?.usage) ? (
				<div className="message-foot">
					{!animating && (
						<div className="message-actions">
							<CopyButton message={message} what="reply" />
							{asked && !busy && (
								<Button type="button" variant="ghost" aria-label="Retry" title="Ask for this reply again" onClick={() => void resend(asked.id, textOf(asked))}>
									<RetryIcon />
								</Button>
							)}
						</div>
					)}
					<ReplyMeta message={message} live={animating} />
				</div>
			) : !animating && (
				<div className="message-actions">
					<CopyButton message={message} what={user ? 'message' : 'reply'} />
					{user && !busy && !message.metadata?.command && (
						<Button type="button" variant="ghost" aria-label="Edit message" title="Edit message" onClick={() => setEditing(true)}>
							<RenameIcon />
						</Button>
					)}
					{asked && !busy && (
						<Button type="button" variant="ghost" aria-label="Retry" title="Ask for this reply again" onClick={() => void resend(asked.id, textOf(asked))}>
							<RetryIcon />
						</Button>
					)}
				</div>
			)}
		</Message>
	);
});

// MessageEditor edits an owner's message in place. Sending says it again: Mob's replies after it give way to a new one.
function MessageEditor({ text, cancel, send }: { text: string; cancel: () => void; send: (text: string) => void }) {
	const [value, setValue] = useState(text);
	const box = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
	}, [value]);
	useEffect(() => {
		const el = box.current;
		el?.focus();
		el?.setSelectionRange(el.value.length, el.value.length);
	}, []);
	const changed = value.trim() !== '' && value.trim() !== text.trim();
	return (
		<form
			className="message-editor"
			onSubmit={(e) => {
				e.preventDefault();
				if (changed) send(value);
			}}
		>
			<Textarea
				ref={box}
				aria-label="Edit message"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') cancel();
					else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						e.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			<div className="message-editor-bar">
				<span className="muted">Mob’s replies after this message are replaced.</span>
				<Button type="button" variant="ghost" onClick={cancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={!changed}>
					Send
				</Button>
			</div>
		</form>
	);
}

// toolState turns an AI SDK tool state into what the row shows: running, waiting for approval, done or failed.
function toolState(state: string): { kind: string; label: string; icon: ReactNode } {
	if (state === 'approval-requested') return { kind: 'waiting', label: 'Waiting for your approval', icon: <HandIcon /> };
	if (state === 'output-available') return { kind: 'done', label: 'Done', icon: <CheckIcon /> };
	if (state === 'output-error') return { kind: 'failed', label: 'Failed', icon: <CrossIcon /> };
	if (state === 'output-denied') return { kind: 'failed', label: 'Denied', icon: <CrossIcon /> };
	return { kind: 'running', label: 'Running', icon: <SpinnerIcon /> };
}

const toolTitles: Record<string, string> = {
	remember: 'Save memory',
	sandbox: 'Run command',
	tool_search: 'Search tools',
	skill: 'Use skill',
	web_fetch: 'Fetch page',
	web_search: 'Search the web',
};
// toolTitle names a tool in words: a known title, or its id with separators as spaces.
function toolTitle(name: string) {
	const known = toolTitles[name];
	if (known) return known;
	const words = name.replace(/[_.-]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}
// toolDetail shows the call's first text argument on the row, such as the fact or the command.
function toolDetail(input: unknown) {
	if (!input || typeof input !== 'object') return '';
	const value = Object.values(input).find((v) => typeof v === 'string');
	return typeof value === 'string' ? value : '';
}

// UserText shows what the owner typed as they typed it: line breaks kept, `code` and fenced blocks in a monospace face,
// and no tables or toolbars. A long message folds to its first lines until opened.
function UserText({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.split('\n').length > foldLines || text.length > foldLength;
	const pieces = fences(text);
	return (
		<div className="user-text-wrap">
			<div className="user-text" data-folded={(long && !open) || undefined}>
				{pieces.map((piece, i) =>
					i % 2 ? (
						<pre key={i}>{piece}</pre>
					) : (
						<span key={i}>
							{around(piece, i > 0, i < pieces.length - 1)
								.split(/(`[^`\n]+`)/)
								.map((bit, j) => (j % 2 ? <code key={j}>{bit.slice(1, -1)}</code> : bit))}
						</span>
					),
				)}
			</div>
			{long && (
				<button type="button" className="user-text-more" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? 'Show less' : 'Show more'}
				</button>
			)}
		</div>
	);
}
// fences splits text into plain runs (even indexes) and the insides of fenced code blocks (odd indexes), as Markdown reads
// them: a block closes only on a line of the same fence character, at least as long as its opening, so a ```` block can
// hold ``` examples. An opening fence that never closes stays as typed.
export function fences(text: string) {
	const lines = text.split('\n');
	const pieces: string[] = [];
	let plain: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		// A backtick fence's info string cannot hold a backtick, or ```a``` would open a block.
		if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
			const fence = open[1];
			const end = lines.findIndex((line, j) => {
				if (j <= i) return false;
				const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
				return !!close && close[1][0] === fence[0] && close[1].length >= fence.length;
			});
			if (end > 0) {
				pieces.push(plain.join('\n'), lines.slice(i + 1, end).join('\n'));
				plain = [];
				i = end;
				continue;
			}
		}
		plain.push(lines[i]);
	}
	pieces.push(plain.join('\n'));
	return pieces;
}
// around drops the line breaks next to a fenced block, whose own spacing replaces them.
function around(text: string, after: boolean, before: boolean) {
	if (after) text = text.replace(/^\n+/, '');
	if (before) text = text.replace(/\n+$/, '');
	return text;
}
const foldLines = 12;
const foldLength = 1200;

function CopyButton({ message, what }: { message: { parts: { type: string; text?: string }[] }; what: 'message' | 'reply' }) {
	const [result, setResult] = useState<'copied' | 'failed'>();
	useEffect(() => {
		if (!result) return;
		const timer = setTimeout(() => setResult(undefined), 1500);
		return () => clearTimeout(timer);
	}, [result]);
	const text = message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n\n');
	if (!text) return null;
	const label = result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed' : `Copy ${what}`;
	return (
		<Button
			type="button"
			variant="ghost"
			aria-label={label}
			title={label}
			onClick={() => {
				// Writing fails when the page is not focused or the browser denies clipboard access.
				Promise.resolve(navigator.clipboard?.writeText(text) ?? Promise.reject())
					.then(() => setResult('copied'))
					.catch(() => setResult('failed'));
			}}
		>
			{result === 'copied' ? <CheckIcon /> : result === 'failed' ? <CrossIcon /> : <CopyIcon />}
		</Button>
	);
}
