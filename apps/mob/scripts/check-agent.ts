// Runs one real coding task through Claude Agent, end to end, in a scratch
// repository: the agent writes a module and its test, runs the test and
// reports with task_result. It needs Claude Code signed in (`claude`, then
// /login) or ANTHROPIC_API_KEY, and is skipped without `claude`.
//   bun apps/mob/scripts/check-agent.ts [--confined]
// --confined runs the agent with full permission, as agents.confinement cloud
// does, and so only in a Claude Code cloud environment.
import { ConversationService, Store, type Message } from '@mob/core';
import { openBun } from '@mob/core/sqlite/bun';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Service } from '../src/agents/service';
import { tools } from '../src/agents/tools';

const { values } = parseArgs({ options: { confined: { type: 'boolean', default: false } } });
if (!Bun.which('claude')) {
	console.log('check-agent: skipped, `claude` is not installed');
	process.exit(0);
}
if (values.confined && process.env.CLAUDE_CODE_REMOTE !== 'true') throw new Error('--confined runs only in a Claude Code cloud environment');

const temp = () => mkdtempSync(join(tmpdir(), 'mob-check-agent-'));
const git = (dir: string, ...args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=mob', '-c', 'user.email=mob@example.com', ...args], { cwd: dir });
const repo = temp();
git(repo, 'init', '-q', '-b', 'main');
await Bun.write(join(repo, 'README.md'), '# check\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'start');

const store = new Store(openBun(join(temp(), 'mob.sqlite')), 'check-agent').open();
const conv = new ConversationService(store);
const svc = new Service(store, conv, temp());
svc.confined = values.confined;
conv.setDelegate(svc);
conv.tools.register(...tools(svc));

const began = Date.now(), deadline = began + 5 * 60_000;
let task = await svc.startTask('', repo, 'claude', 'Add add.js', 'Write add.js exporting add(a, b) as CommonJS, and add.test.js testing it with node:test. Run `node --test` and make sure it passes. Do not commit.');
// Approves what the agent asks, as the owner would, and remembers what.
const asked: string[] = [];
for (;;) {
	while (conv.isActive(task.conversationId) && Date.now() < deadline) await Bun.sleep(200);
	const pending = conv.pending(task.conversationId);
	if (!pending.length || Date.now() > deadline) break;
	asked.push(String((pending[0]!.input as { title?: string } | undefined)?.title ?? pending[0]!.tool));
	await conv.execute({ id: task.conversationId, text: '', requestId: crypto.randomUUID(), approval: { id: pending[0]!.id, approved: true }, owner: true }, () => {});
}
task = store.task(task.id)!;
const history = store.history(task.conversationId);
const last = history[history.length - 1] as Message | undefined;
const reply = last?.parts.filter(p => p.type === 'text').map(p => String(p.text ?? '')).join('') ?? '';
const usage = store.history(task.conversationId).reduce((n, m) => n + ((m.metadata?.usage as { inputTokens?: number } | undefined)?.inputTokens ?? 0), 0);
console.log(JSON.stringify({ status: task.status, outcome: task.outcome, seconds: (Date.now() - began) / 1000, asked, usage }));

try {
	assert.equal(last?.metadata?.error, undefined, `the task failed: ${last?.metadata?.error}`);
	assert.equal(task.status, 'review', `the task ended ${task.status}: ${reply}`);
	assert.equal(task.outcome, 'passed', 'the agent did not report with task_result');
	assert.ok(await Bun.file(join(task.worktree, 'add.test.js')).exists(), 'the agent wrote no test');
	assert.equal(Bun.spawnSync(['node', '--test'], { cwd: task.worktree }).exitCode, 0, "the agent's test fails");
	assert.ok(!asked.some(a => a.startsWith('mcp__mob')), "the agent asked before Mob's own tools");
	if (values.confined) assert.deepEqual(asked, [], 'a confined agent asked the owner');
	assert.ok(usage > 0, 'no usage was recorded');
	console.log(`check-agent: Claude Agent finished a task${values.confined ? ' with full permission' : ''}, asking ${asked.length} time(s)`);
} finally {
	await conv.close();
	svc.close();
	store.close();
}
process.exit(0);
