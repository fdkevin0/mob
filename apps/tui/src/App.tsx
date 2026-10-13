import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { InputRenderable, ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { ConversationClient, type MobClient, type Conversation, type Snapshot, type ChatMessage, type Action } from '@mob/client';
import { getToolName, isToolUIPart } from 'ai';

type ToolPart = Extract<ChatMessage['parts'][number], { toolCallId: string }>;

// Model/tool content is data, not terminal escape instructions.
export function safe(text: string) {
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
function json(value: unknown) {
	return safe(JSON.stringify(value, null, 2) ?? 'No value');
}
function preview(value: unknown) {
	const full = json(value);
	return full.length > 240 ? full.slice(0, 240) + '\n… F3 shows full details' : full;
}

function Tool({ part, details }: { part: ToolPart; details: boolean }) {
	return (
		<box flexDirection="column" flexShrink={0} paddingLeft={1} borderStyle="single" border={['left']} borderColor="#64748b">
			<text fg={part.state === 'output-error' ? '#fb7185' : '#67e8f9'}>{safe(`${getToolName(part)} · ${part.state}`)}</text>
			<text wrapMode="char">{`Input: ${details ? json(part.input) : preview(part.input)}`}</text>
			{part.state === 'output-available' && <text wrapMode="char">{`Result: ${details ? json(part.output) : preview(part.output)}`}</text>}
			{part.state === 'output-error' && <text fg="#fb7185">{`Error: ${safe(part.errorText)}`}</text>}
			{part.state === 'approval-requested' && <text fg="#fbbf24">Approval required · F4 to review</text>}
		</box>
	);
}

function Message({ message, details }: { message: ChatMessage; details: boolean }) {
	return (
		<box flexDirection="column" flexShrink={0} marginBottom={1}>
			<text fg={message.role === 'user' ? '#c4b5fd' : '#67e8f9'}>
				<strong>{message.role.toUpperCase()}</strong>
			</text>
			{message.parts.map((part, index) => {
				if (part.type === 'text')
					return (
						<text key={index} wrapMode="word">
							{safe(part.text)}
						</text>
					);
				if (part.type === 'reasoning') return details ? <text key={index} fg="#94a3b8">{`Reasoning: ${safe(part.text)}`}</text> : null;
				if (isToolUIPart(part)) return <Tool key={index} part={part} details={details} />;
				return null;
			})}
			{message.metadata?.error && <text fg="#fb7185">{safe(message.metadata.error)}</text>}
		</box>
	);
}

export function App({
	client,
	initial,
	conversation,
	onExit,
}: {
	client: MobClient;
	initial: Snapshot;
	conversation: Conversation;
	onExit: () => void;
}) {
	const { width, height } = useTerminalDimensions();
	const [current, setCurrent] = useState(conversation);
	const [panel, setPanel] = useState<'chat' | 'sessions' | 'approvals' | 'decision' | 'deny'>('chat');
	const [list, setList] = useState<Conversation[]>([]);
	const [query, setQuery] = useState('');
	const [searchFocused, setSearchFocused] = useState(true);
	const [details, setDetails] = useState(false);
	const [notice, setNotice] = useState('');
	const [opening, setOpening] = useState(false);
	const sessions = useRef(new Map<string, ConversationClient>());
	const actionHandler = useRef<(action: Action) => void>(() => {});
	const input = useRef<TextareaRenderable>(null);
	const denial = useRef<InputRenderable>(null);
	const transcript = useRef<ScrollBoxRenderable>(null);
	const [approval, setApproval] = useState<ToolPart>();
	const [session, setSession] = useState(() => makeSession(conversation.id, initial));
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
	const pending = state.messages.flatMap((m) => m.parts.filter(isToolUIPart)).filter((p) => p.state === 'approval-requested');
	actionHandler.current = (action) => {
		if (action.kind === 'open-conversation' && action.conversationId) void open(action.conversationId);
		else setNotice(`The pilot does not implement ${action.kind} forms. Use Web or mob tui; no action was performed.`);
	};

	function makeSession(id: string, snapshot: Snapshot): ConversationClient {
		const existing = sessions.current.get(id);
		if (existing) return existing;
		const next = new ConversationClient({
			client,
			id,
			initial: snapshot,
			clientType: 'tui',
			onAction: (action) => actionHandler.current(action),
		});
		sessions.current.set(id, next);
		return next;
	}
	useEffect(() => session.start(), [session]);
	useEffect(() => {
		if (input.current && input.current.plainText !== state.input) input.current.setText(state.input);
	}, [session, state.input, panel]);

	async function open(id: string) {
		if (opening) return;
		setOpening(true);
		setNotice('Opening conversation…');
		try {
			const snapshot = await client.openConversation(id);
			const conversations = await client.listConversations();
			const selected = conversations.find((c) => c.id === id);
			if (!selected) throw new Error('Conversation is no longer available.');
			setSession(makeSession(id, snapshot));
			setCurrent(selected);
			setPanel('chat');
			setNotice('');
		} catch (error) {
			setNotice(String(error));
		} finally {
			setOpening(false);
		}
	}
	async function showSessions() {
		try {
			setList(await client.listConversations());
			setQuery('');
			setSearchFocused(true);
			setPanel('sessions');
			setNotice('');
		} catch (error) {
			setNotice(String(error));
		}
	}
	async function create() {
		try {
			const created = await client.createConversation();
			await open(created.id);
		} catch (error) {
			setNotice(String(error));
		}
	}
	function submit() {
		if (state.busy) {
			setNotice('A turn is running. Draft kept; Ctrl+S stops it. No message was queued.');
			return;
		}
		// Read the editor at the key event: React may not have rendered a paste yet.
		setNotice('');
		void session.submit(input.current?.plainText ?? state.input);
		// The paste and reset can be batched into the same React render.
		input.current?.setText(session.getSnapshot().input);
	}
	function decide(approved: boolean, reason?: string, remember?: 'conversation' | 'always') {
		if (!approval || approval.state !== 'approval-requested') return;
		void session.decide(approval.approval.id, approved, reason, remember);
		setPanel('chat');
	}
	useKeyboard((key) => {
		if (key.ctrl && key.name === 'q') {
			key.preventDefault();
			onExit();
			return;
		}
		if (key.ctrl && key.name === 's') {
			key.preventDefault();
			setNotice('Stop requested for this conversation.');
			void session.cancel();
			return;
		}
		if (key.ctrl && key.name === 'c') {
			key.preventDefault();
			setNotice('Ctrl+S stops the turn; Ctrl+Q exits the terminal.');
			return;
		}
		if (key.name === 'f2') {
			key.preventDefault();
			void showSessions();
			return;
		}
		if (key.name === 'f3') {
			key.preventDefault();
			setDetails(!details);
			return;
		}
		if (key.name === 'f4') {
			key.preventDefault();
			setPanel('approvals');
			return;
		}
		if (key.name === 'escape') {
			key.preventDefault();
			setPanel('chat');
			session.dismissCommand();
			setNotice('');
			return;
		}
		if (panel === 'sessions' && key.name === 'tab') {
			key.preventDefault();
			setSearchFocused(!searchFocused);
			return;
		}
		if (panel === 'sessions' && key.ctrl && key.name === 'n') {
			key.preventDefault();
			void create();
			return;
		}
		if (['chat', 'decision', 'deny'].includes(panel) && (key.name === 'pageup' || key.name === 'pagedown')) {
			key.preventDefault();
			transcript.current?.scrollBy(key.name === 'pageup' ? -1 : 1, 'viewport');
		}
	});

	const options = list
		.filter((c) => `${c.title} ${c.id}`.toLowerCase().includes(query.toLowerCase()))
		.map((c) => ({
			name: safe(c.title || 'Untitled'),
			description: c.id === current.id ? 'Current conversation' : c.id,
			value: c.id,
		}));
	const status = state.approvalBusy
		? 'Applying approval…'
		: state.streaming
			? 'Streaming…'
			: state.remoteBusy
				? 'Following service turn…'
				: state.busy
					? 'Working…'
					: 'Ready';
	const error = state.failure || (state.error ? String(state.error) : '');
	const panelHeight = Math.max(3, height - 8);
	return (
		<box width={width} height={height} flexDirection="column" backgroundColor="#0f172a" paddingX={1}>
			<text fg="#67e8f9" flexShrink={0} truncate>
				<strong>{`Mob · TS pilot · ${safe(current.title || 'Untitled')}`}</strong>
			</text>
			<text fg="#94a3b8" flexShrink={0} truncate>{`${safe(state.model)} · ${status} · ${pending.length} approvals`}</text>
			{error && (
				<text fg="#fb7185" flexShrink={0} maxHeight={2}>
					{safe(error)}
				</text>
			)}
			{notice && (
				<text fg="#fbbf24" flexShrink={0} maxHeight={2}>
					{safe(notice)}
				</text>
			)}
			{panel === 'sessions' ? (
				<box flexDirection="column" flexGrow={1} minHeight={3}>
					<text fg="#c4b5fd">Conversations · search, then Tab / arrows / Enter · Ctrl+N new</text>
					<input
						focused={searchFocused}
						placeholder="Search titles / IDs"
						onInput={setQuery}
						onSubmit={() => options[0] && void open(options[0].value)}
					/>
					<select
						focused={!searchFocused}
						options={options}
						height={Math.max(2, panelHeight - 3)}
						onSelect={(_, option) => option && void open(String(option.value))}
					/>
				</box>
			) : panel === 'approvals' ? (
				<box flexDirection="column" flexGrow={1}>
					<text fg="#fbbf24">Choose a pending request · Esc returns to chat</text>
					{pending.length ? (
						<select
							focused
							height={panelHeight}
							options={pending.map((p) => ({ name: safe(getToolName(p)), description: preview(p.input), value: p }))}
							onSelect={(_, option) => {
								if (option) {
									setApproval(option.value as ToolPart);
									setPanel('decision');
								}
							}}
						/>
					) : (
						<text>No pending approvals. New requests appear in the transcript.</text>
					)}
				</box>
			) : panel === 'decision' || panel === 'deny' ? (
				<box flexDirection="column" flexGrow={1}>
					<scrollbox ref={transcript} height={Math.max(2, panelHeight - 7)}>
						<text fg="#fbbf24">{`Authorize ${approval ? safe(getToolName(approval)) : ''}`}</text>
						<text wrapMode="char">{json(approval?.input)}</text>
					</scrollbox>
					<text fg="#94a3b8">{`Once: this call. Conversation: matching scope here. Always: matching scope across chats.\nThe service determines the scope/target; inspect /grants and revoke with /revoke. Approval is not sandbox isolation.`}</text>
					{panel === 'deny' ? (
						<input
							ref={denial}
							focused
							placeholder="Optional denial reason · Enter denies · Esc cancels"
							onSubmit={() => decide(false, denial.current?.value)}
						/>
					) : (
						<select
							focused
							height={4}
							showDescription={false}
							options={['Allow once', 'Allow for this conversation', 'Always allow matching scope', 'Deny…'].map((name, value) => ({
								name,
								value,
								description: '',
							}))}
							onSelect={(_, option) => {
								if (option?.value === 3) setPanel('deny');
								else if (option) decide(true, undefined, option.value === 1 ? 'conversation' : option.value === 2 ? 'always' : undefined);
							}}
						/>
					)}
				</box>
			) : (
				<>
					<scrollbox
						ref={transcript}
						flexGrow={1}
						minHeight={2}
						stickyScroll
						stickyStart="bottom"
						contentOptions={{ flexDirection: 'column', paddingRight: 1 }}
					>
						{state.commandResult ? (
							<text>
								{safe(state.commandResult)}
								{'\n\nEsc returns to transcript'}
							</text>
						) : (
							state.messages.map((message) => <Message key={message.id} message={message} details={details} />)
						)}
						{state.recovery && (
							<box flexDirection="column" flexShrink={0} marginBottom={1}>
								<text fg="#fbbf24">Unconfirmed send · NOT automatically resent</text>
								<text wrapMode="word">{safe(state.recovery.text)}</text>
								<text fg="#94a3b8">Review original · Enter sends only editor</text>
							</box>
						)}
					</scrollbox>
					<box border borderColor="#64748b" height={Math.max(3, Math.min(6, Math.floor(height / 4)))} flexShrink={0}>
						<textarea
							ref={input}
							focused
							wrapMode="word"
							flexGrow={1}
							initialValue={state.input}
							placeholder="Message · Enter sends · Ctrl+J newline"
							keyBindings={[
								{ name: 'return', action: 'submit' },
								{ name: 'linefeed', action: 'newline' },
								{ name: 'return', shift: true, action: 'newline' },
								{ name: 'return', meta: true, action: 'newline' },
								{ name: 'j', ctrl: true, action: 'newline' },
							]}
							onContentChange={() => {
								const text = input.current?.plainText ?? '';
								if (text !== session.getSnapshot().input) session.setInput(text);
							}}
							onSubmit={submit}
						/>
					</box>
				</>
			)}
			<text fg="#94a3b8" flexShrink={0}>
				{width < 65
					? 'F2 chats · F3 detail · F4 approve\nPgUp/Dn · ^S stop · ^Q exit'
					: 'F2 chats · F3 detail · F4 approve · PgUp/Dn · ^S stop · ^Q exit'}
			</text>
		</box>
	);
}
