import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isToolUIPart } from 'ai';
import { useConversation } from './useConversation';
import { useCompletion } from './useCompletion';
import {
	Conversation as ChatConversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from '../components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../components/ai-elements/message';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogTrigger } from '../components/ui/dialog';
import { api, type ChatMessage, type Connection, type Snapshot } from './api';
import type { Action } from './contracts';
import { ModelPicker } from './ModelPicker';
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronIcon, CopyIcon, CrossIcon, HandIcon, SpinnerIcon, StopIcon } from './icons';

export function Thread({
	connection,
	id,
	initial,
	title,
	onBusy,
	onChanged,
	onAction,
	onLeave,
	draft,
	clearDraft,
}: {
	connection: Connection;
	id: string;
	initial: Snapshot;
	title?: string;
	onBusy: (busy: boolean) => void;
	onChanged: () => void;
	onAction: (action: Action) => void;
	onLeave?: (snapshot: Snapshot) => void;
	/** draft is a message typed before a runner was connected; the first thread opened takes it into its composer. */
	draft?: string;
	clearDraft?: () => void;
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
		decide,
		cancel,
		commandResult,
		dismissCommand,
	} = useConversation({ connection, id, initial, onBusy, onChanged, onAction, onLeave });
	useEffect(() => {
		if (!draft) return;
		setInput(draft);
		clearDraft?.();
	}, []);
	const completion = useCompletion({ connection, id, input, setInput });
	const [choosing, setChoosing] = useState(false);
	const [defaultModel, setDefaultModel] = useState<string>();
	useEffect(() => {
		let live = true;
		api<{ defaultModel?: string }>(connection, '/config')
			.then((config) => {
				if (live) setDefaultModel(config.defaultModel);
			})
			.catch(() => {
				/* the header stays usable without the default model */
			});
		return () => {
			live = false;
		};
	}, [connection]);
	const modelLabel = model?.startsWith('demo/') ? 'Demo mode · no model calls' : model || 'Connecting…';
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
			<header className="thread-header">
				<h1 className="thread-title">{title || 'New conversation'}</h1>
			</header>
			<ChatConversation className="conversation">
				<ConversationContent className="conversation-content">
					{messages.length === 0 && (
						<ConversationEmptyState
							className="empty-state"
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
						/>
					))}
					{busy && (
						<p className="thinking" role="status">
							{remoteBusy && !streaming && !approvalBusy ? 'A turn is running in another client…' : 'Working…'}
						</p>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</ChatConversation>
			<div className="composer-area">
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
								<span>{s.label}</span>
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
						<Dialog open={choosing} onOpenChange={setChoosing}>
							<DialogTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									className="model-button"
									aria-haspopup="dialog"
									aria-expanded={choosing}
									title="This conversation's model; choose another without typing /model"
								>
									{modelLabel}
									<ChevronDownIcon />
								</Button>
							</DialogTrigger>
							{choosing && (
								<ModelPicker
									connection={connection}
									current={model}
									defaultModel={defaultModel}
									onPick={(choice) => {
										setChoosing(false);
										run(choice ? `/model ${choice}` : '/model default');
									}}
								/>
							)}
						</Dialog>
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
				</form>
			</div>
		</>
	);
}

type Decide = (approvalId: string, approved: boolean, reason?: string, remember?: string) => Promise<void> | void;

// MessageView renders one message. It is memoized so that streaming a reply re-renders only that reply,
// not the whole history: the client keeps unchanged messages as the same objects.
const MessageView = memo(function MessageView({
	message,
	animating,
	last,
	busy,
	decide,
	proceed,
}: {
	message: ChatMessage;
	animating: boolean;
	last: boolean;
	busy: boolean;
	decide: Decide;
	proceed: () => void;
}) {
	return (
		<Message from={message.role}>
			<p className="sr-only">{message.role === 'user' ? 'You' : 'Mob'}</p>
			<MessageContent className={message.role === 'user' ? 'user-bubble' : 'assistant-content'}>
				{message.parts.map((part, index) => {
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
								<p>{part.text}</p>
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
								{part.state !== 'approval-requested' && (
									<div className="tool-body">
										<pre>{JSON.stringify(part.input, null, 2)}</pre>
										{part.state === 'output-available' && <pre>{JSON.stringify(part.output, null, 2)}</pre>}
										{part.state === 'output-error' && <p role="alert">{part.errorText}</p>}
									</div>
								)}
								{part.state === 'approval-requested' && (
									<ApprovalPrompt
										question={
											name === 'remember' ? 'Mob wants to save this to memory.' : `Mob wants to use ${toolTitle(name).toLowerCase()}.`
										}
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
			{message.role === 'assistant' && !animating && <CopyButton message={message} />}
		</Message>
	);
});

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

function CopyButton({ message }: { message: { parts: { type: string; text?: string }[] } }) {
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
	const label = result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed' : 'Copy reply';
	return (
		<div className="message-actions">
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
		</div>
	);
}

/**
 * ApprovalPrompt asks the user to decide a tool request. An approval may be remembered for this conversation or always,
 * so calls like it stop asking; a denial may say why, and Mob answers it.
 */
function ApprovalPrompt({
	question,
	busy,
	decide,
}: {
	question: string;
	busy: boolean;
	decide: (approved: boolean, reason?: string, remember?: string) => void;
}) {
	const [denying, setDenying] = useState(false);
	const [reason, setReason] = useState('');
	return (
		<div className="approval-prompt">
			<p className="approval-question">{question}</p>
			{denying ? (
				<form
					className="approval-actions"
					onSubmit={(e) => {
						e.preventDefault();
						decide(false, reason);
					}}
				>
					<Input
						aria-label="Reason for denying (optional)"
						placeholder="Tell Mob why (optional)"
						value={reason}
						maxLength={2000}
						autoFocus
						onChange={(e) => setReason(e.target.value)}
					/>
					<Button disabled={busy}>Deny</Button>
					<Button type="button" variant="ghost" onClick={() => setDenying(false)}>
						Back
					</Button>
				</form>
			) : (
				<div className="approval-actions">
					<Button disabled={busy} onClick={() => decide(true)}>
						Approve
					</Button>
					<Button variant="outline" disabled={busy} onClick={() => decide(true, undefined, 'conversation')}>
						Allow in this conversation
					</Button>
					<Button variant="outline" disabled={busy} onClick={() => decide(true, undefined, 'always')}>
						Always allow
					</Button>
					<Button variant="ghost" disabled={busy} onClick={() => setDenying(true)}>
						Deny…
					</Button>
				</div>
			)}
			<p className="approval-note">Approval expires after one hour. Remembered approvals are listed by /grants.</p>
		</div>
	);
}
