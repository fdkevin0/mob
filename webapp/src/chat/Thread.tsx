import { useEffect, useState } from 'react';
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
import { api, type Connection, type Snapshot } from './api';
import type { Action } from './contracts';
import { ModelPicker } from './ModelPicker';

export function Thread({
	connection,
	id,
	initial,
	background,
	onBusy,
	onChanged,
	onAction,
	draft,
	clearDraft,
}: {
	connection: Connection;
	id: string;
	initial: Snapshot;
	background: boolean;
	onBusy: (busy: boolean) => void;
	onChanged: () => void;
	onAction: (action: Action) => void;
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
	} = useConversation({ connection, id, initial, onBusy, onChanged, onAction });
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
	const modelLabel = model?.startsWith('demo/') ? 'Demo mode · no model calls' : (model ?? 'Connecting…');
	return (
		<>
			<header className="thread-header">
				<div>
					<p className="workspace-label">Your workspace</p>
					<Dialog open={choosing} onOpenChange={setChoosing}>
						<DialogTrigger asChild>
							<Button
								variant="ghost"
								className="model-button"
								aria-haspopup="dialog"
								aria-expanded={choosing}
								title="This conversation's model; choose another without typing /model"
							>
								{modelLabel}
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
				</div>
				<span
					className="badge"
					title={background ? 'Continues after this window closes' : 'Lifetime is controlled by the process that started the service'}
				>
					{background ? 'Background service' : 'Session service'}
				</span>
			</header>
			<ChatConversation className="conversation">
				<ConversationContent className="conversation-content">
					{messages.length === 0 && (
						<ConversationEmptyState
							title="What’s on your mind?"
							description="Ask a question, explore an idea, or save something to remember."
						/>
					)}
					{messages.map((message) => (
						<Message key={message.id} from={message.role}>
							<p className="message-role">{message.role === 'user' ? 'You' : 'Mob'}</p>
							<MessageContent>
								{message.parts.map((part, index) => {
									if (part.type === 'text')
										return (
											<MessageResponse key={index} isAnimating={streaming && message === messages.at(-1)}>
												{part.text}
											</MessageResponse>
										);
									if (part.type === 'reasoning')
										return (
											<details className="reasoning" key={index}>
												<summary>Reasoning</summary>
												<p>{part.text}</p>
											</details>
										);
									if (isToolUIPart(part))
										return (
											<section className="tool-card" key={part.toolCallId}>
												<strong>{part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5)}</strong>
												<span className="tool-state">{part.state}</span>
												<pre>{JSON.stringify(part.input, null, 2)}</pre>
												{part.state === 'approval-requested' && (
													<ApprovalPrompt
														question={part.type === 'tool-remember' ? 'Save this fact locally?' : 'Allow this request?'}
														busy={busy}
														decide={(approved, reason, remember) => void decide(part.approval.id, approved, reason, remember)}
													/>
												)}
												{part.state === 'output-available' && <pre>{JSON.stringify(part.output, null, 2)}</pre>}
												{part.state === 'output-error' && <p role="alert">{part.errorText}</p>}
											</section>
										);
									return null;
								})}
								{message.metadata?.status === 'step-limit' ? (
									<div className="step-limit">
										<p className="muted" role="status">
											Stopped after reaching the tool step limit.
										</p>
										{message === messages.at(-1) && !busy && (
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
						</Message>
					))}
					{busy && (
						<p className="muted" role="status">
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
						id="message"
						placeholder="Message Mob…"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						rows={2}
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
					{busy ? (
						<Button type="button" onClick={() => void cancel()}>
							Stop
						</Button>
					) : (
						<Button disabled={!input.trim()}>Send ↑</Button>
					)}
				</form>
				<p className="composer-hint">Type / for commands · Tab completes · Enter to send · Shift+Enter for a new line</p>
			</div>
		</>
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
	const [reason, setReason] = useState('');
	const approving = busy || reason.trim() !== '';
	return (
		<div className="approval-prompt">
			<p>{question} Approval expires after one hour. Remembered approvals are listed by /grants.</p>
			<Input
				aria-label="Reason for denying (optional)"
				placeholder="Reason for denying (optional)"
				value={reason}
				maxLength={2000}
				onChange={(e) => setReason(e.target.value)}
			/>
			<Button disabled={approving} onClick={() => decide(true)}>
				Approve
			</Button>
			<Button variant="outline" disabled={approving} onClick={() => decide(true, undefined, 'conversation')}>
				Allow in this conversation
			</Button>
			<Button variant="outline" disabled={approving} onClick={() => decide(true, undefined, 'always')}>
				Always allow
			</Button>
			<Button variant="outline" disabled={busy} onClick={() => decide(false, reason)}>
				Deny
			</Button>
		</div>
	);
}
