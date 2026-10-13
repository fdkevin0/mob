// End-to-end contract check: the real Go server consumed by the actual AI SDK UI parser.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultChatTransport, isToolUIPart, readUIMessageStream, validateUIMessages, type UIMessage } from 'ai';
import { ConversationClient, MobClient, type ChatMessage } from '@mob/client';

const dir = await mkdtemp(join(tmpdir(), 'mob-contract-'));
const binary = join(dir, 'mob');
let processHandle: ChildProcess | undefined;
let url = '';
let token = '';
async function start() {
  const child = spawn(binary, ['serve'], { env: { ...process.env, MOB_CONFIG: join(dir, 'config.yaml'), MOB_STATE_DIR: dir, MOB_DEMO: '1', MOB_DATA_DIR: dir, MOB_ADDR: '127.0.0.1:0', MOB_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle = child;
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Go server did not start')), 15_000);
    let stdout = '', stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.stdout!.on('data', chunk => { stdout += chunk; const match = stdout.match(/Mob: (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Go exited ${code}: ${stderr}`)); });
  });
  token = (await readFile(join(dir, 'token'), 'utf8')).trim();
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const exited = once(processHandle, 'exit'); processHandle.kill('SIGTERM'); await exited; processHandle = undefined;
}
async function request(path: string, body?: object) {
  return fetch(`${url}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}
async function turn(id: string, body: object) {
  const transport = new DefaultChatTransport({ api: `${url}/api/chat`, headers: { Authorization: `Bearer ${token}` }, prepareSendMessagesRequest: () => ({ body: { id, ...body } }) });
  const stream = await transport.sendMessages({ chatId: id, messages: [], trigger: 'submit-message', messageId: undefined, abortSignal: undefined });
  let final: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, terminateOnError: true })) final = message;
  return final;
}

async function until(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 12_000;
  while (!await check()) {
    assert(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function textOf(messages: ChatMessage[]) {
  return messages.flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text).join('\n');
}

async function sharedClients() {
  const client = new MobClient({ url, token });
  const { id } = await client.createConversation();
  let web = new ConversationClient({ client, id, initial: await client.openConversation(id), clientType: 'web' });
  let detachWeb = web.start();
  let detachTui: (() => void) | undefined;
  let follows = 0;
  try {
    await web.submit('/list');
    assert(web.getSnapshot().commandResult?.includes(id), 'web command output omitted the conversation');
    const prompt = '共同阅读 中文\n'.repeat(160).trim();
    const sending = web.submit(prompt);
    await until(async () => (await client.openConversation(id)).active, 'service-owned turn starts');
    const tuiClient = new MobClient({ url, token }, { fetch: async (input, init) => {
      if (String(input).endsWith(`/chat/${id}/stream`) && ++follows === 1) throw new TypeError('simulated lost connection');
      return fetch(input, init);
    } });
    const tui = new ConversationClient({ client: tuiClient, id, initial: await client.openConversation(id), clientType: 'tui' });
    detachTui = tui.start();
    await until(() => tui.getSnapshot().failure === 'simulated lost connection', 'tui surfaces follow failure');
    await until(() => follows >= 2 && textOf(tui.getSnapshot().messages).includes('Received:'), 'tui reconnects to the same live turn');
    assert(web.getSnapshot().streaming && tui.getSnapshot().busy, 'both clients must read the same live turn');
    detachWeb();
    await sending;
    assert((await client.openConversation(id)).active, 'detaching Web must not stop the turn');
    detachWeb = web.start();
    const expected = `[Demo mode — no model request]\n\nReceived: ${prompt}\n\nUse /remember a fact to exercise persistent approval.`;
    await until(() => !web.getSnapshot().busy && !tui.getSnapshot().busy && textOf(web.getSnapshot().messages).includes(expected) && textOf(tui.getSnapshot().messages).includes(expected), 'both readers receive complete replayed text');
    const saved = await client.openConversation(id);
    assert.equal(saved.messages.filter(m => m.role === 'user').length, 1, 'reconnecting must not submit the prompt twice');
    assert.equal(saved.messages.filter(m => m.role === 'assistant').length, 1, 'replaying must not duplicate the reply');
    assert.equal(saved.messages.at(-1)?.parts.filter(p => p.type === 'text').map(p => p.text).join(''), expected);
    assert.deepEqual(web.getSnapshot().messages.map(m => m.id), saved.messages.map(m => m.id));
    assert.deepEqual(tui.getSnapshot().messages.map(m => m.id), saved.messages.map(m => m.id));
    assert.equal(web.getSnapshot().recovery, undefined, 'accepted running send must not be offered for resubmission');
    assert.equal(web.getSnapshot().input, '', 'accepted running send must not restore a duplicate draft');
    await tui.submit('/list');
    assert(tui.getSnapshot().commandResult?.includes(id), 'tui command output omitted the conversation');
    assert.deepEqual((await client.complete(id, '/model d', 'tui')).map(s => s.value), ['default', 'demo/echo']);

    await tui.submit('/remember shared-approved-fact');
    const pending = (await client.openConversation(id)).messages.flatMap(m => m.parts).find(p => isToolUIPart(p) && p.state === 'approval-requested');
    assert(pending && isToolUIPart(pending) && pending.state === 'approval-requested');
    await web.submit(`/approve ${pending.approval.id} conversation`);
    let afterApproval = await client.openConversation(id);
    assert.equal(afterApproval.messages.flatMap(m => m.parts).filter(p => isToolUIPart(p) && p.toolCallId === pending.toolCallId && p.state === 'output-available').length, 1, 'approved effect has exactly one result');
    await until(() => !tui.getSnapshot().busy, 'tui is idle before stale approval');
    await tui.decide(pending.approval.id, true);
    assert(tui.getSnapshot().failure.includes('already decided'), `duplicate decision must be refused: ${tui.getSnapshot().failure}`);
    assert.deepEqual((await client.openConversation(id)).messages, afterApproval.messages, 'duplicate decision must not change history or rerun the effect');

    await web.submit('/remember covered-by-conversation-grant');
    afterApproval = await client.openConversation(id);
    const covered = afterApproval.messages.flatMap(m => m.parts).filter(isToolUIPart).find(p => (p.input as { fact?: string })?.fact === 'covered-by-conversation-grant');
    assert(covered?.state === 'output-available', 'conversation grant must run the covered call without asking again');
    await web.submit('/revoke all');
    await web.submit('/remember shared-denied-fact');
    const denied = (await client.openConversation(id)).messages.flatMap(m => m.parts).find(p => isToolUIPart(p) && p.state === 'approval-requested');
    assert(denied && isToolUIPart(denied) && denied.state === 'approval-requested');
    await until(() => !tui.getSnapshot().busy, 'tui ready to deny');
    await tui.submit(`/deny ${denied.approval.id} do not retain this`);
    const denial = await client.openConversation(id);
    assert(denial.messages.flatMap(m => m.parts).some(p => isToolUIPart(p) && p.toolCallId === denied.toolCallId && p.state === 'output-denied'));
    assert(!denial.messages.flatMap(m => m.parts).some(p => isToolUIPart(p) && p.toolCallId === denied.toolCallId && p.state === 'output-available'), 'denied effect must not run');
    assert(textOf(denial.messages).includes('do not retain this'), 'denial reason must reach the continuation');

    await until(() => !web.getSnapshot().busy, 'web ready for cancellation scenario');
    const stopping = web.submit('stop-target '.repeat(180));
    await until(() => web.getSnapshot().streaming && textOf(web.getSnapshot().messages).includes('Received: stop-target'), 'partial reply before Stop');
    await tui.cancel();
    await stopping;
    await until(async () => !(await client.openConversation(id)).active, 'service turn stops');
    const stopped = await client.openConversation(id);
    assert.equal(stopped.messages.at(-1)?.metadata?.status, 'cancelled');
    assert(textOf([stopped.messages.at(-1)!]).length < 'stop-target '.repeat(180).length, 'Stop must leave a partial, not completed, reply');
    await until(() => !web.getSnapshot().busy && !tui.getSnapshot().busy, 'both clients observe Stop');
    await validateUIMessages({ messages: stopped.messages });
    web.setInput('Continue must keep this unsent 草稿');
    await web.proceed();
    assert.equal(web.getSnapshot().input, 'Continue must keep this unsent 草稿');
    const continued = await client.openConversation(id);
    assert.equal(textOf(continued.messages.filter(m => m.role === 'user').slice(-1)), 'Continue');
    console.log('Shared client ↔ Go: web/tui commands, Chinese multiline text, concurrent readers, reconnect/detach, history, approval scope, stale decision, denial and cross-client Stop passed.');
  } finally {
    detachWeb(); detachTui?.();
  }
}

async function detachedSends() {
  const client = new MobClient({ url, token });
  for (const accepted of [false, true]) {
    const { id } = await client.createConversation();
    const initial = await client.openConversation(id);
    const text = '相同文本 不同请求ID\n'.repeat(12).trim();
    let other: Promise<UIMessage | undefined> | undefined;
    if (!accepted) {
      other = turn(id, { text, requestId: `other-${id}` });
      await until(async () => (await client.openConversation(id)).active, 'another client occupies conversation');
    }
    let release!: () => void;
    let requestId = '';
    let posts = 0;
    let status = 0;
    const delayed = new MobClient({ url, token }, { fetch: async (input, init) => {
      if (!String(input).endsWith('/api/chat')) return fetch(input, init);
      posts++;
      requestId = JSON.parse(String(init?.body)).requestId;
      const response = await fetch(input, init);
      status = response.status;
      await new Promise<void>(resolve => { release = resolve; });
      return response;
    } });
    const session = new ConversationClient({ client: delayed, id, initial, clientType: 'tui' });
    let detach = session.start();
    try {
      const sending = session.submit(text);
      await until(() => !!release, 'real Go response is held before SDK receives it');
      assert.equal(status, accepted ? 200 : 409);
      session.setInput('新草稿不能被覆盖');
      detach();
      await other;
      await until(async () => !(await client.openConversation(id)).active, 'backend finishes while client is detached');
      release();
      await sending;
      detach = session.start();
      await until(() => !session.getSnapshot().busy, 'same client reconciles detached send');
      const saved = await client.openConversation(id);
      assert.deepEqual(session.getSnapshot().messages, saved.messages);
      assert.equal(session.getSnapshot().input, '新草稿不能被覆盖');
      assert.equal(posts, 1, 'reattachment must never post again');
      assert.equal(saved.messages.filter(m => m.role === 'user').length, 1);
      assert.equal(saved.messages.filter(m => m.role === 'assistant').length, 1);
      if (accepted) {
        assert.equal(saved.messages.find(m => m.role === 'user')?.id, requestId);
        assert.equal(session.getSnapshot().recovery, undefined);
        assert.equal(session.getSnapshot().failure, '');
      } else {
        assert.notEqual(saved.messages.find(m => m.role === 'user')?.id, requestId);
        assert.equal(textOf(saved.messages.filter(m => m.role === 'user')), text);
        assert.deepEqual(session.getSnapshot().recovery, { requestId, text });
        assert.match(session.getSnapshot().failure, /not confirmed/i);
      }
    } finally { detach(); }
  }
  console.log('Detached sends ↔ Go: real 409 refusal with identical text under another ID, late accepted completed turn, same-instance reattach, original request IDs, preserved newer drafts, no automatic resend passed.');
}

try {
  await writeFile(join(dir, 'config.yaml'), '{}\n', { mode: 0o600 });
  const build = spawnSync('go', ['build', '-o', binary, './cmd/mob'], { stdio: 'inherit' });
  assert.equal(build.status, 0, 'Go build failed');
  await start();
  assert.equal((await fetch(`${url}/api/conversations`)).status, 401);
  const conversation = await (await request('/conversations', {})).json() as { id: string };
  const id = conversation.id;
  const reply = await turn(id, { text: '你好，Mob', requestId: 'hello' });
  assert(reply?.parts.some(p => p.type === 'text' && p.text.includes('你好，Mob')));
  assert.equal((await request('/chat', { id, text: 'repeat', requestId: 'hello' })).status, 409);
  const models = await turn(id, { text: '/models', requestId: 'models' });
  assert(models?.parts.some(p => p.type === 'text' && p.text.includes('**`demo/echo`** (current)')), '/models did not list the current model');
  const suggestions = await (await request('/commands/complete', { client: 'web', conversationId: id, text: '/model d' })).json() as { value: string }[];
  assert.deepEqual(suggestions.map(s => s.value), ['default', 'demo/echo'], '/model did not complete its argument');
  const listed = await (await request('/commands/run', { client: 'web', conversationId: id, text: '/list' })).json() as { handled: boolean; markdown: string };
  assert(listed.handled && listed.markdown.includes(id), '/list did not run in the service');
  const current = await (await request(`/conversations/${id}`)).json() as { model: string };
  assert.equal(current.model, 'demo/echo');
  const pending = await turn(id, { text: '/remember 喜欢简洁的回复', requestId: 'memory' });
  const tool = pending?.parts.find(isToolUIPart);
  assert(tool?.state === 'approval-requested', 'AI SDK did not recognize the approval event');
  await turn(id, { approval: { id: tool.approval.id, approved: true } });
  assert.equal((await request('/chat', { id, approval: { id: tool.approval.id, approved: true } })).status, 409);
  const denied = await turn(id, { text: '/remember do not save this', requestId: 'denial' });
  const deniedTool = denied?.parts.find(isToolUIPart);
  assert(deniedTool?.state === 'approval-requested');
  await turn(id, { approval: { id: deniedTool.approval.id, approved: false } });
  const snapshot = await (await request(`/conversations/${id}`)).json() as { messages: UIMessage[] };
  await validateUIMessages({ messages: snapshot.messages });
  assert(snapshot.messages.flatMap(m => m.parts).some(p => isToolUIPart(p) && p.state === 'output-available'));
  assert(snapshot.messages.flatMap(m => m.parts).some(p => isToolUIPart(p) && p.state === 'output-denied'));
  await stop(); await start();
  const restored = await (await request(`/conversations/${id}`)).json();
  assert.deepEqual(restored.messages, snapshot.messages, 'history changed across restart');
  console.log('Go ↔ AI SDK UI: text, /models, approvals, denial, deduplication, validation and restart passed.');
  await sharedClients();
  await detachedSends();
} finally {
  await stop(); await rm(dir, { recursive: true, force: true });
}
