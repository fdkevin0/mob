import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, readUIMessageStream } from 'ai';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, type ChatMessage, type Connection, type Snapshot } from './api';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useConversation({ connection, id, initial, onBusy, onChanged }: { connection: Connection; id: string; initial: Snapshot; onBusy: (busy: boolean) => void; onChanged: () => void }) {
  const [input, setInput] = useState('');
  const [remoteBusy, setRemoteBusy] = useState(initial.active);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const submittedText = useRef('');
  const approvalController = useRef<AbortController | null>(null);
  const refreshGeneration = useRef(0);
  const transport = useMemo(() => new DefaultChatTransport<ChatMessage>({
    api: `${connection.url}/api/chat`, headers: { Authorization: `Bearer ${connection.token}` },
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
  const busy = streaming || approvalBusy || remoteBusy;
  const busyRef = useRef(false); busyRef.current = streaming || approvalBusy;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => () => { approvalController.current?.abort(); }, []);
  async function refresh() {
    const generation = refreshGeneration.current;
    const snapshot = await api<Snapshot>(connection, `/conversations/${id}`);
    if (generation !== refreshGeneration.current || busyRef.current) return;
    setMessages(snapshot.messages); setRemoteBusy(snapshot.active);
  }
  useEffect(() => {
    if (streaming || approvalBusy) return;
    let live = true;
    const reload = () => { if (live) void refresh().catch(e => { if (live) setFailure(errorText(e)); }); };
    reload(); const timer = setInterval(reload, 2000); onChanged();
    return () => { live = false; clearInterval(timer); };
  }, [streaming, approvalBusy, connection, id]);
  function submit(event: FormEvent) {
    event.preventDefault(); if (!input.trim() || busy) return;
    const text = input.trim(); submittedText.current = text; setInput(''); setFailure(''); clearError(); refreshGeneration.current++; busyRef.current = true;
    void sendMessage({ text });
  }
  async function decide(approvalId: string, approved: boolean) {
    if (busy) return; refreshGeneration.current++; busyRef.current = true; setApprovalBusy(true); setFailure(''); clearError();
    const controller = new AbortController(); approvalController.current = controller;
    try {
      const stream = await transport.sendMessages({ chatId: id, messages: [], trigger: 'submit-message', messageId: undefined, abortSignal: controller.signal, body: { approval: { id: approvalId, approved } } });
      const baseline = (await api<Snapshot>(connection, `/conversations/${id}`)).messages.filter(m => m.metadata?.status !== 'streaming');
      for await (const message of readUIMessageStream<ChatMessage>({ stream, terminateOnError: true })) {
        if (approved) setMessages([...baseline, message]);
      }
    } catch (e) { if (!controller.signal.aborted) setFailure(errorText(e)); }
    finally { setApprovalBusy(false); busyRef.current = false; approvalController.current = null; }
  }
  async function cancel() {
    try { await api(connection, `/conversations/${id}/stop`, {}); approvalController.current?.abort(); await stop(); }
    catch (e) { setFailure(errorText(e)); }
  }
 return { input, setInput, remoteBusy, approvalBusy, failure, messages, streaming, busy, error, submit, decide, cancel };
}
