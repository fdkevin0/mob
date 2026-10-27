// GitHub sources and the npx skills global v3 lock format. Shared locks are read-only.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { SkillPreview, SkillsOverview, SkillUpdate } from '@mob/client/contracts';
import { writeAtomic } from '../files';
import { Library, maxText, split } from './skills';

const path = z.string().max(1024).refine(s => s === 'SKILL.md' || (!s.includes('\\') && s.split('/').every(p => p && p !== '.' && p !== '..' && !p.includes(':')) && s.endsWith('/SKILL.md')), 'Expected a repository path ending in SKILL.md');
export const repositoryInput = z.object({ source: z.string().regex(/^[\w][\w.-]*\/[\w][\w.-]*$/), ref: z.string().min(1).max(255).optional() });
export const sourceInput = repositoryInput.extend({ skillPath: path });
export const installInput = sourceInput.extend({ commit: z.string().regex(/^[a-f0-9]{40}$/) });
export const nameInput = z.object({ name: z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/) });
const entrySchema = z.object({ source: z.string(), sourceType: z.string(), sourceUrl: z.string(), ref: z.string().optional(), skillPath: z.string().optional(), skillFolderHash: z.string(), installedAt: z.string(), updatedAt: z.string() }).passthrough();
const lockSchema = z.object({ version: z.literal(3), skills: z.record(z.string(), entrySchema) }).passthrough();
type Lock = z.infer<typeof lockSchema>;
const treeSchema = z.object({ sha: z.string(), truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string(), mode: z.string(), size: z.number().optional() })) });
type Tree = z.infer<typeof treeSchema>;

export function readLock(file: string): Lock {
  if (!existsSync(file)) return { version: 3, skills: {} };
  const parsed = lockSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Unsupported or invalid skills lock: ${file}. Expected npx skills global format v3; project v1 hashes are different.`);
  return parsed.data;
}

export const sharedLockPath = () => process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : join(homedir(), '.agents', '.skill-lock.json');

export class SkillMarket {
  private busy = false;
  constructor(readonly library: Library, readonly lockFile: string, readonly sharedLock = sharedLockPath(), readonly fetcher: typeof fetch = fetch) {}

  // All remote reads are bounded, including chunked responses without Content-Length.
  private async bytes(url: string, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const res = await this.fetcher(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`GitHub returned ${res.status}; check the public repository, ref and API rate limit.`); }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('GitHub returned an empty response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error('GitHub response exceeds the size limit');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  private async tree(source: string, ref = 'HEAD', signal?: AbortSignal): Promise<Tree> {
    const tree = treeSchema.parse(JSON.parse(new TextDecoder().decode(await this.bytes(`https://api.github.com/repos/${source}/git/trees/${encodeURIComponent(ref)}?recursive=1`, 16 << 20, signal))));
    if (tree.truncated) throw new Error('GitHub returned an incomplete repository tree; this repository is too large');
    return tree;
  }

  async discover(input: z.infer<typeof repositoryInput>, signal?: AbortSignal) {
    return (await this.tree(input.source, input.ref, signal)).tree.filter(e => e.type === 'blob' && (e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md'))).map(e => e.path);
  }

  async overview(check = false, signal?: AbortSignal): Promise<SkillsOverview> {
    const [skills, problems] = this.library.scan();
    const warnings = problems.map(p => `${p.dir}: ${p.message}`);
    const locks = [this.lockFile, this.sharedLock].map(file => {
      try { return readLock(file); } catch (e) { warnings.push((e as Error).message); return { version: 3, skills: {} } as Lock; }
    });
    const trees = new Map<string, Promise<Tree>>();
    const result: SkillsOverview = { skills: [], warnings };
    for (const skill of skills) {
      const own = dirname(skill.dir) === this.library.roots[0];
      const entries = locks[own ? 0 : 1]!.skills;
      const entry = Object.hasOwn(entries, skill.name) ? entries[skill.name] : undefined;
      let update: SkillUpdate | undefined;
      if (check) {
        const skillPath = entry?.skillPath?.replaceAll('\\', '/').replace(/\/$/, '');
        const input = sourceInput.safeParse({ source: entry?.source, ref: entry?.ref, skillPath: skillPath === '' ? 'SKILL.md' : skillPath && (/SKILL\.md$/i.test(skillPath) ? skillPath.replace(/SKILL\.md$/i, 'SKILL.md') : skillPath + '/SKILL.md') });
        if (!entry || entry.sourceType !== 'github' || !entry.skillFolderHash || !input.success) {
          update = { status: 'unknown', message: 'No supported GitHub v3 lock entry; install with a tracked source to check updates.' };
        } else {
          try {
            const key = JSON.stringify([input.data.source, input.data.ref]);
            if (!trees.has(key)) trees.set(key, this.tree(input.data.source, input.data.ref, signal));
            const tree = await trees.get(key)!;
            const folder = input.data.skillPath === 'SKILL.md' ? '' : input.data.skillPath.slice(0, -9);
            const hash = folder ? tree.tree.find(e => e.type === 'tree' && e.path === folder)?.sha : tree.sha;
            update = !hash ? { status: 'unknown', message: 'The source no longer contains this skill folder.' } : hash === entry.skillFolderHash ? { status: 'current', message: 'Up to date with the tracked ref.' } : { status: 'available', message: 'Source changes available. Installed files have not been changed.' };
          } catch (e) { update = { status: 'error', message: (e as Error).message }; }
        }
      }
      result.skills.push({ name: skill.name, description: skill.description, compatibility: skill.compatibility, managed: own && !!entry && !lstatSync(skill.dir).isSymbolicLink(), source: entry?.source, ref: entry?.ref, update });
    }
    return result;
  }

  async preview(input: z.infer<typeof sourceInput>, commit?: string, signal?: AbortSignal): Promise<SkillPreview> {
    if (!commit) {
      const data = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(new TextDecoder().decode(await this.bytes(`https://api.github.com/repos/${input.source}/commits/${encodeURIComponent(input.ref ?? 'HEAD')}`, 1 << 20, signal))));
      commit = data.sha;
    }
    const tree = await this.tree(input.source, commit, signal);
    const folder = input.skillPath === 'SKILL.md' ? '' : input.skillPath.slice(0, -9);
    const prefix = folder ? folder + '/' : '';
    const files = tree.tree.filter(e => e.type !== 'tree' && e.path.startsWith(prefix));
    if (!files.some(e => e.path === input.skillPath)) throw new Error('This source does not contain the requested SKILL.md');
    if (files.length > 512 || files.reduce((sum, e) => sum + (e.size ?? 0), 0) > 16 << 20) throw new Error('Skill exceeds 512 files or 16 MiB');
    for (const file of files) {
      if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode) || file.path.slice(prefix.length).split('/').some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes(':'))) throw new Error('Skill contains unsupported links or paths');
    }
    const content = new TextDecoder().decode(await this.bytes(`https://raw.githubusercontent.com/${input.source}/${commit}/${input.skillPath.split('/').map(encodeURIComponent).join('/')}`, maxText, signal));
    const [meta] = split(content);
    const name = nameInput.parse({ name: meta.name }).name;
    if (typeof meta.description !== 'string' || !meta.description.trim()) throw new Error('SKILL.md needs a description');
    const folderHash = folder ? tree.tree.find(e => e.type === 'tree' && e.path === folder)?.sha : tree.sha;
    if (!folderHash) throw new Error('Skill folder not found');
    return { ...input, commit, name, description: meta.description.trim().slice(0, 1024), content, files: files.map(e => e.path.slice(prefix.length)), executableFiles: files.filter(e => e.mode === '100755').map(e => e.path.slice(prefix.length)), folderHash };
  }

  async install(input: z.infer<typeof installInput>, signal?: AbortSignal) {
    if (this.busy) throw new Error('Another skill operation is running; retry when it finishes');
    this.busy = true;
    let temp: string | undefined;
    try {
      const preview = await this.preview(input, input.commit, signal);
      const root = this.library.roots[0]!;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const destination = join(root, preview.name);
      if (existsSync(destination) || this.library.find(preview.name)) throw new Error('A skill with this name already exists. Remove it explicitly before installing another source.');
      const lock = readLock(this.lockFile);
      temp = mkdtempSync(join(root, '.install-'));
      const prefix = input.skillPath === 'SKILL.md' ? '' : input.skillPath.slice(0, -8);
      let bytes = 0;
      for (const file of preview.files) {
        const data = await this.bytes(`https://raw.githubusercontent.com/${input.source}/${input.commit}/${(prefix + file).split('/').map(encodeURIComponent).join('/')}`, (16 << 20) - bytes, signal);
        bytes += data.length;
        mkdirSync(dirname(join(temp, file)), { recursive: true, mode: 0o700 });
        await Bun.write(join(temp, file), data);
        chmodSync(join(temp, file), preview.executableFiles.includes(file) ? 0o700 : 0o600);
      }
      const now = new Date().toISOString();
      lock.skills[preview.name] = { source: input.source, sourceType: 'github', sourceUrl: `https://github.com/${input.source}`, ref: input.ref, skillPath: input.skillPath, skillFolderHash: preview.folderHash, installedAt: now, updatedAt: now };
      signal?.throwIfAborted();
      renameSync(temp, destination);
      temp = undefined;
      try { writeAtomic(this.lockFile, JSON.stringify(lock, null, 2) + '\n'); }
      catch (e) { rmSync(destination, { recursive: true, force: true }); throw e; }
      return { name: preview.name };
    } finally { if (temp) rmSync(temp, { recursive: true, force: true }); this.busy = false; }
  }

  remove(name: string) {
    if (this.busy) throw new Error('Another skill operation is running; retry when it finishes');
    const lock = readLock(this.lockFile);
    const skill = this.library.find(name);
    if (!Object.hasOwn(lock.skills, name) || !skill || dirname(skill.dir) !== this.library.roots[0] || lstatSync(skill.dir).isSymbolicLink()) throw new Error('Only skills installed by Mob can be removed here');
    const staged = join(dirname(skill.dir), `.remove-${crypto.randomUUID()}`);
    renameSync(skill.dir, staged);
    delete lock.skills[name];
    try { writeAtomic(this.lockFile, JSON.stringify(lock, null, 2) + '\n'); }
    catch (e) { renameSync(staged, skill.dir); throw e; }
    rmSync(staged, { recursive: true, force: true });
    return { removed: name };
  }
}
