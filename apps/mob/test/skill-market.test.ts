import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SkillMarket, readLock, sourceInput } from '../src/skills/market';
import { Library } from '../src/skills/skills';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const content = '---\nname: example\ndescription: Example skill\n---\nRead references/guide.md before working.';
const commit = 'a'.repeat(40), hash = 'b'.repeat(40);
const source = { source: 'owner/repo', skillPath: 'skills/example/SKILL.md', ref: 'release/v1' };
const entry = { ...source, sourceType: 'github', sourceUrl: 'https://github.com/owner/repo', skillFolderHash: hash, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
function write(file: string, data: string) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); }
function fixture(respond?: (url: string) => Response | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-market-')); dirs.push(dir);
  const own = join(dir, 'skills'), shared = join(dir, 'shared', 'skills');
  const requests: string[] = [];
  const tree = { sha: 'c'.repeat(40), truncated: false, tree: [
    { path: 'skills/example', type: 'tree', sha: hash, mode: '040000' },
    { path: source.skillPath, type: 'blob', sha: 'd'.repeat(40), mode: '100644', size: content.length },
    { path: 'skills/example/references/guide.md', type: 'blob', sha: 'e'.repeat(40), mode: '100644', size: 5 },
    { path: 'skills/example/scripts/run.sh', type: 'blob', sha: 'f'.repeat(40), mode: '100755', size: 10 },
  ] };
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    return respond?.(url) ?? (url.includes('/commits/') ? Response.json({ sha: commit }) : url.includes('/git/trees/') ? Response.json(tree) : new Response(url.endsWith('SKILL.md') ? content : 'hello'));
  }) as typeof fetch;
  const market = new SkillMarket(new Library([own, shared]), join(dir, '.skill-lock.json'), join(dir, 'shared', '.skill-lock.json'), fetcher);
  return { dir, own, shared, requests, tree, market };
}

test('checks npx skills v3 folder hashes and refs without changing shared files or lock', async () => {
  const f = fixture();
  write(join(f.shared, 'example', 'SKILL.md'), content);
  // The CLI accepts both folder paths and SKILL.md paths.
  write(f.market.sharedLock, JSON.stringify({ version: 3, skills: { example: { ...entry, skillPath: 'skills/example' } }, lastSelectedAgents: ['claude-code'], dismissed: { findSkillsPrompt: true } }));
  const before = readFileSync(f.market.sharedLock, 'utf8');
  expect((await f.market.overview(true)).skills[0]).toMatchObject({ managed: false, source: source.source, update: { status: 'current' } });
  expect(f.requests[0]).toContain('release%2Fv1');
  f.tree.tree[0]!.sha = '9'.repeat(40);
  expect((await f.market.overview(true)).skills[0]?.update?.status).toBe('available');
  expect(readFileSync(f.market.sharedLock, 'utf8')).toBe(before);
  expect(readFileSync(join(f.shared, 'example', 'SKILL.md'), 'utf8')).toBe(content);
  expect(() => f.market.remove('example')).toThrow('Only skills installed by Mob');
});

test('batches checks by source and ref; unrelated repository changes do not mark a skill outdated', async () => {
  const f = fixture();
  write(join(f.shared, 'example', 'SKILL.md'), content);
  write(join(f.shared, 'second', 'SKILL.md'), content.replace('name: example', 'name: second'));
  write(f.market.sharedLock, JSON.stringify({ version: 3, skills: { example: entry, second: entry } }));
  const result = await f.market.overview(true);
  expect(result.skills.map(s => s.update?.status)).toEqual(['current', 'current']);
  expect(f.requests).toHaveLength(1);
});

test('reports malformed and project v1 locks instead of treating them as up to date', async () => {
  const f = fixture(); write(join(f.shared, 'example', 'SKILL.md'), content);
  for (const lock of ['broken', JSON.stringify({ version: 1, skills: { example: { computedHash: hash } } }), JSON.stringify({ version: 4, skills: {} })]) {
    write(f.market.sharedLock, lock);
    const result = await f.market.overview(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.skills[0]?.update?.status).toBe('unknown');
    expect(readFileSync(f.market.sharedLock, 'utf8')).toBe(lock);
  }
  expect(f.requests).toHaveLength(0);
});

test('reports API failures and missing folders separately from current', async () => {
  const f = fixture(() => new Response('rate limited', { status: 403 }));
  write(join(f.shared, 'example', 'SKILL.md'), content);
  write(f.market.sharedLock, JSON.stringify({ version: 3, skills: { example: entry } }));
  expect((await f.market.overview(true)).skills[0]?.update).toMatchObject({ status: 'error', message: expect.stringContaining('403') });
  const missing = fixture(); write(join(missing.shared, 'example', 'SKILL.md'), content);
  write(missing.market.sharedLock, JSON.stringify({ version: 3, skills: { example: { ...entry, skillPath: 'deleted/SKILL.md' } } }));
  expect((await missing.market.overview(true)).skills[0]?.update?.status).toBe('unknown');
});

test('root skills compare the root tree hash, not a commit hash', async () => {
  const f = fixture();
  write(join(f.shared, 'example', 'SKILL.md'), content);
  write(f.market.sharedLock, JSON.stringify({ version: 3, skills: { example: { ...entry, skillPath: '', skillFolderHash: f.tree.sha } } }));
  expect((await f.market.overview(true)).skills[0]?.update?.status).toBe('current');
});

test('rejects an oversized streamed SKILL.md even when the tree advertises a small file', async () => {
  const f = fixture(url => url.startsWith('https://raw.') ? new Response('x'.repeat((256 << 10) + 1)) : undefined);
  await expect(f.market.install({ ...source, commit })).rejects.toThrow('size limit');
  expect(existsSync(join(f.own, 'example'))).toBe(false);
});

test('previews, installs a pinned commit, writes a compatible lock and removes only its own files', async () => {
  const f = fixture();
  expect(await f.market.discover(source)).toEqual([source.skillPath]);
  const preview = await f.market.preview(source);
  expect(preview).toMatchObject({ name: 'example', commit, folderHash: hash, executableFiles: ['scripts/run.sh'] });
  expect(existsSync(f.own)).toBe(false);
  write(f.market.lockFile, JSON.stringify({ version: 3, skills: {}, dismissed: { findSkillsPrompt: true } }));
  await f.market.install({ ...source, commit: preview.commit });
  expect(f.requests.filter(u => u.startsWith('https://raw.')).every(u => u.includes('/' + commit + '/'))).toBe(true);
  expect(readFileSync(join(f.own, 'example', 'references/guide.md'), 'utf8')).toBe('hello');
  if (process.platform !== 'win32') expect(statSync(join(f.own, 'example', 'scripts/run.sh')).mode & 0o100).toBe(0o100);
  expect(readLock(f.market.lockFile)).toMatchObject({ version: 3, skills: { example: { ...entry, installedAt: expect.any(String), updatedAt: expect.any(String) } }, dismissed: { findSkillsPrompt: true } });
  expect((await f.market.overview(true)).skills[0]).toMatchObject({ managed: true, update: { status: 'current' } });
  await expect(f.market.install({ ...source, commit })).rejects.toThrow('already exists');
  f.market.remove('example');
  expect(existsSync(join(f.own, 'example'))).toBe(false);
  expect(readLock(f.market.lockFile).skills).toEqual({});
});

test('refuses to shadow a shared skill or remove a linked skill', async () => {
  const f = fixture(); write(join(f.shared, 'example', 'SKILL.md'), content);
  await expect(f.market.install({ ...source, commit })).rejects.toThrow('already exists');
  mkdirSync(f.own, { recursive: true }); symlinkSync(join(f.shared, 'example'), join(f.own, 'example'));
  write(f.market.lockFile, JSON.stringify({ version: 3, skills: { example: entry } }));
  expect(() => f.market.remove('example')).toThrow('Only skills installed by Mob');
  expect(existsSync(join(f.shared, 'example', 'SKILL.md'))).toBe(true);
});

test('prototype property names do not turn untracked skills into managed installations', async () => {
  const f = fixture();
  write(join(f.own, 'constructor', 'SKILL.md'), content.replace('name: example', 'name: constructor'));
  expect((await f.market.overview()).skills[0]?.managed).toBe(false);
  expect(() => f.market.remove('constructor')).toThrow('Only skills installed by Mob');
  expect(existsSync(join(f.own, 'constructor', 'SKILL.md'))).toBe(true);
});

test('rejects links, oversized and truncated trees, and unsafe source paths', async () => {
  const f = fixture();
  f.tree.tree[1]!.mode = '120000';
  await expect(f.market.preview(source)).rejects.toThrow('unsupported links');
  f.tree.tree[1]!.mode = '100644'; f.tree.tree[1]!.size = 17 << 20;
  await expect(f.market.preview(source)).rejects.toThrow('16 MiB');
  f.tree.truncated = true;
  await expect(f.market.preview(source)).rejects.toThrow('incomplete');
  for (const skillPath of ['../SKILL.md', '/SKILL.md', 'skills/../../SKILL.md', 'C:/SKILL.md']) expect(sourceInput.safeParse({ ...source, skillPath }).success).toBe(false);
  expect(sourceInput.safeParse({ ...source, source: '../repo' }).success).toBe(false);
});

test('failed downloads leave no installed files or lock record', async () => {
  const f = fixture(url => url.endsWith('guide.md') ? new Response('failed', { status: 500 }) : undefined);
  await expect(f.market.install({ ...source, commit })).rejects.toThrow('500');
  expect(existsSync(join(f.own, 'example'))).toBe(false);
  expect(readLock(f.market.lockFile).skills).toEqual({});
});

test('cancelled downloads clean up and release the installer for a subsequent request', async () => {
  const abort = new AbortController();
  const f = fixture(url => { if (url.endsWith('guide.md')) abort.abort(new Error('cancelled')); return undefined; });
  await expect(f.market.install({ ...source, commit }, abort.signal)).rejects.toThrow('cancelled');
  expect(existsSync(join(f.own, 'example'))).toBe(false);
  expect(readLock(f.market.lockFile).skills).toEqual({});
  await f.market.install({ ...source, commit });
  expect(existsSync(join(f.own, 'example', 'SKILL.md'))).toBe(true);
});

test('an invalid existing lock prevents installation without overwriting it', async () => {
  const f = fixture();
  // An existing invalid lock must never be reset by installing a skill.
  write(f.market.lockFile, '{ invalid');
  await expect(f.market.install({ ...source, commit })).rejects.toThrow();
  expect(existsSync(join(f.own, 'example'))).toBe(false);
  expect(readFileSync(f.market.lockFile, 'utf8')).toBe('{ invalid');
});
