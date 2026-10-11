import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, readUIMessageStream } from 'ai';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, authorizedFetch, type ChatMessage, type Connection, type Snapshot } from './api';
import type { Action, CommandRequest, CommandResult } from './contracts';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useConversation({ connection, id, initial, onBusy, onChanged, onAction }: { connection: Connection; id: string; initial: Snapshot; onBusy: (busy: boolean) => void; onChanged: () => void; onAction?: (action: Action) => void }) {
  const [input, setInput] = useState('');
  const [remoteBusy, setRemoteBusy] = useState(initial.active);
  const [model, setModel] = useState(initial.model);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [running, setRunning] = useState(false);
  const [commandResult, setCommandResult] = useState<string>();
  const submittedText = useRef('');
  const approvalController = useRef<AbortController | null>(null);
  const followController = useRef<AbortController | null>(null);
  const [following, setFollowing] = useState(false);
  const refreshGeneration = useRef(0);
  const transport = useMemo(() => new DefaultChatTransport<ChatMessage>({
    api: `${connection.url}/api/chat`, headers: { Authorization: `Bearer ${connection.token}` }, fetch: authorizedFetch,
    prepareSendMessagesRequest: ({ messages, body }) => {
      if (body?.approval) return { body: { id, approval: body.approval } };
      const last = messages.at(-1);
      return { body: { id, requestId: last?.id, text: last?.parts.filter(p => p.type === 'text').map(p => p.text).join('') } };
    },
  }), [connection, id]);
  const { messages, setMessages, sendMessage, status, error, stop, clearError } = useChat<ChatMessage>({
    id, messages: initial.messages, transport,
    onError: () => setInput(current => current || submittedText.current),
  });
  const streaming = status === 'submitted' || status === 'streaming';
  const busy = streaming || approvalBusy || remoteBusy || running || following;
  const busyRef = useRef(false); busyRef.current = streaming || approvalBusy || following;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => () => { approvalController.current?.abort(); followController.current?.abort(); }, []);
  async function refresh() {
    const generation = refreshGeneration.current;
    const snapshot = await api<Snapshot>(connection, `/conversations/${id}`);
    if (generation !== refreshGeneration.current || busyRef.current) return;
    setMessages(snapshot.messages); setRemoteBusy(snapshot.active); setModel(snapshot.model);
    if (snapshot.active) void follow(snapshot.messages);
  }
  // follow streams a running turn here too, whichever client started it. The
  // service replays it from the start, so each attempt builds the reply afresh
  // and replaces its saved draft; polling pauses until it ends.
  async function follow(baseline: ChatMessage[]) {
    if (followController.current) return;
    const controller = new AbortController(); followController.current = controller; busyRef.current = true; setFollowing(true);
    try {
      const stream = await transport.reconnectToStream({ chatId: id, abortSignal: controller.signal });
      if (!stream) return;
      setFailure('');
      const earlier = baseline.filter(m => m.metadata?.status !== 'streaming');
      for await (const message of readUIMessageStream<ChatMessage>({ stream, terminateOnError: true })) {
        if (!controller.signal.aborted) setMessages([...earlier.filter(m => m.id !== message.id), message]);
      }
    } catch (e) { if (!controller.signal.aborted) setFailure(errorText(e)); }
    finally { followController.current = null; setFollowing(false); }
  }
  useEffect(() => {
    if (streaming || approvalBusy || following) return;
    let live = true;
    const reload = () => { if (live) void refresh().catch(e => { if (live) setFailure(errorText(e)); }); };
    reload(); const timer = setInterval(reload, 2000); onChanged();
    return () => { live = false; clearInterval(timer); };
  }, [streaming, approvalBusy, following, connection, id]);
  function submit(event: FormEvent) {
    event.preventDefault(); if (!input.trim() || busy) return;
    const text = input.trim(); setInput(''); setFailure(''); clearError(); setCommandResult(undefined);
    if (text.startsWith('/') && !/[\r\n]/.test(text)) void run(text); else send(text);
  }
  function send(text: string) {
    submittedText.current = text; clearError(); refreshGeneration.current++; busyRef.current = true;
    void sendMessage({ text });
  }
  // run asks the service to run a slash command; one it does not run comes back
  // unhandled and is sent as chat.
  async function run(text: string) {
    setRunning(true);
    const request: CommandRequest = { client: 'web', conversationId: id, text };
    try {
      const result = await api<CommandResult>(connection, '/commands/run', request);
      if (!result.handled) { send(text); return; }
      if (result.markdown) setCommandResult(result.markdown);
      if (result.action?.kind === 'decide') void decide(result.action.approvalId ?? '', result.action.approved ?? false, result.action.reason, result.action.remember);
      else if (result.action) onAction?.(result.action);
    } catch (e) { setFailure(errorText(e)); setInput(current => current || text); }
    finally { setRunning(false); }
  }
  async function decide(approvalId: string, approved: boolean, reason?: string, remember?: string) {
    if (busy) return; refreshGeneration.current++; busyRef.current = true; setApprovalBusy(true); setFailure(''); clearError();
    const controller = new AbortController(); approvalController.current = controller;
    try {
      const stream = await transport.sendMessages({ chatId: id, messages: [], trigger: 'submit-message', messageId: undefined, abortSignal: controller.signal, body: { approval: { id: approvalId, approved, reason: reason?.trim() || undefined, remember: remember || undefined } } });
      const baseline = (await api<Snapshot>(connection, `/conversations/${id}`)).messages.filter(m => m.metadata?.status !== 'streaming');
      for await (const message of readUIMessageStream<ChatMessage>({ stream, terminateOnError: true })) {
        // A denial with a reason gets an answer from the model.
        if (approved || reason?.trim()) setMessages([...baseline, message]);
      }
    } catch (e) { if (!controller.signal.aborted) setFailure(errorText(e)); }
    finally { setApprovalBusy(false); busyRef.current = false; approvalController.current = null; }
  }
  async function cancel() {
    try { await api(connection, `/conversations/${id}/stop`, {}); approvalController.current?.abort(); followController.current?.abort(); await stop(); }
    catch (e) { setFailure(errorText(e)); }
  }
 return { model, input, setInput, remoteBusy, approvalBusy, failure, messages, streaming, busy, error, submit, decide, cancel, commandResult, dismissCommand: () => setCommandResult(undefined) };
}
