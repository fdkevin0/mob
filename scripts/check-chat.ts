// End-to-end contract check: the real Go server consumed by the actual AI SDK UI parser.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultChatTransport, isToolUIPart, readUIMessageStream, validateUIMessages, type UIMessage } from 'ai';

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
  assert(models?.parts.some(p => p.type === 'text' && p.text.includes('▸ demo/echo')), '/models did not list the current model');
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
} finally {
  await stop(); await rm(dir, { recursive: true, force: true });
}
