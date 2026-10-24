// Agent Skills (agentskills.io): directories holding a SKILL.md of instructions
// for one kind of task, with optional scripts, references and assets. The model
// sees each skill's name and description, loads a skill's instructions with the
// skill tool when a task matches, and reads its other files on demand. Scripts
// run only in the sandbox, from a copy of the skill in the conversation's
// workspace.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix, relative, sep } from 'node:path';
import { workdir } from '../sandbox/sandbox';
import { safeDir, writeNew } from '../sandbox/workspace';

/** maxSkills bounds how many skills one root offers. */
const maxSkills = 100;
/** maxText bounds a SKILL.md, or another file the model reads, in bytes. */
export const maxText = 256 << 10;
/** maxFiles and maxBytes bound a skill copied into a workspace. */
const maxFiles = 512, maxBytes = 16 << 20;
/** maxListed bounds the files listed when a skill is loaded. */
const maxListed = 100;

const validName = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type Skill = { name: string; description: string; compatibility?: string; /** dir keeps a symlinked skill's link path. */ dir: string };
/** Problem is a skill directory that was skipped, or loaded with a warning. */
export type Problem = { dir: string; message: string };

/** roots are where Mob looks for skills: its own, under the data directory, then the cross-client ~/.agents/skills. */
export const roots = (dataDir: string) => [join(dataDir, 'skills'), join(homedir(), '.agents', 'skills')];

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Library finds skills in its roots each time it is asked, so a skill
 * installed or removed while Mob runs counts from the next turn.
 */
export class Library {
	constructor(
		/** roots are searched in order; a name found in an earlier root shadows later ones. */
		readonly roots: string[],
		/** workspace is the host directory of a conversation's sandbox workspace, or '' without a sandbox. */
		readonly workspace: (conversationId: string) => string = () => '',
	) {}

	/** scan lists the skills in every root, by name within each root, and what was skipped or loaded with a warning. */
	scan(): [Skill[], Problem[]] {
		const found: Skill[] = [], problems: Problem[] = [];
		const seen = new Map<string, string>();
		for (const root of this.roots) {
			let entries: string[];
			try { entries = readdirSync(root).sort(); } catch (err) {
				if (!missing(err)) problems.push({ dir: root, message: (err as Error).message });
				continue;
			}
			let count = 0;
			for (const name of entries) {
				if (name.startsWith('.')) continue;
				const dir = join(root, name);
				// Installers often link a skill in from elsewhere, so a link to a directory counts.
				try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
				if (count === maxSkills) { problems.push({ dir: root, message: `only the first ${maxSkills} skills are offered` }); break; }
				let s: Skill, warning: string;
				try { [s, warning] = read(dir); } catch (err) {
					if (!missing(err)) problems.push({ dir, message: (err as Error).message });
					continue;
				}
				if (warning) problems.push({ dir, message: warning });
				const first = seen.get(s.name);
				if (first) { problems.push({ dir, message: `skipped: ${s.name} is already offered from ${first}` }); continue; }
				seen.set(s.name, dir);
				found.push(s);
				count++;
			}
		}
		return [found, problems];
	}

	/** find is the skill offered under name. */
	find(name: string) { return this.scan()[0].find(s => s.name === name); }

	/** load returns the skill's instructions and files, and copies it into the conversation's workspace so its scripts can run there. */
	load(s: Skill, conversationId: string) {
		const [, body] = split(readText(s.dir, 'SKILL.md'));
		let b = `<skill_content name=${JSON.stringify(s.name)}>\n${body}\n</skill_content>\n`;
		if (s.compatibility) b += `Compatibility: ${s.compatibility}\n`;
		const dir = realpathSync(s.dir);
		const [list, more] = files(dir);
		if (!list.length) return b;
		b += `Files in the skill: ${list.join(', ')}${more ? ', and more' : ''}. Read one with the skill tool's path argument.`;
		try {
			const at = this.copyToWorkspace(dir, s.name, conversationId);
			b += at ? ` The skill is copied to ${at} in the sandbox; resolve its relative paths there and run its scripts with the sandbox tool.`
				: " The sandbox is off, so the skill's scripts cannot run.";
		} catch (err) {
			b += ` The skill could not be copied into the sandbox: ${(err as Error).message}.`;
		}
		return b;
	}

	/** readFile returns one of the skill's text files. */
	readFile(s: Skill, file: string) {
		file = posix.normalize(file.replaceAll('\\', '/'));
		if (posix.isAbsolute(file) || file === '..' || file.startsWith('../')) throw new Error('path must be relative to the skill');
		return readText(s.dir, file);
	}

	/**
	 * copyToWorkspace replaces the skill's copy in the conversation's workspace
	 * and returns where commands see it, or '' without a sandbox. Links and
	 * hidden entries are not copied.
	 */
	copyToWorkspace(dir: string, name: string, conversationId: string) {
		const workspace = this.workspace(conversationId);
		if (!workspace) return '';
		const target = posix.join(copies, name);
		// Commands control the workspace and may plant links in it, so every write is resolved within it.
		const inside = safeDir(workspace, posix.dirname(target));
		rmSync(join(inside, name), { recursive: true, force: true });
		let count = 0, size = 0;
		const walk = (rel: string) => {
			const dest = safeDir(workspace, posix.join(target, rel));
			for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
				if (entry.name.startsWith('.')) continue;
				const from = posix.join(rel, entry.name);
				if (entry.isDirectory()) { walk(from); continue; }
				if (!entry.isFile()) continue;
				const info = statSync(join(dir, from));
				count++;
				if (count > maxFiles || info.size > maxBytes - size) throw new Error(`it has over ${maxFiles} files or ${maxBytes >> 20} MiB`);
				const data = readFileSync(join(dir, from));
				size += data.length;
				writeNew(dest, entry.name, data, (info.mode & 0o111) !== 0);
			}
		};
		try { walk(''); } catch (err) {
			rmSync(join(inside, name), { recursive: true, force: true });
			throw err;
		}
		return posix.join(workdir, target);
	}

	/** describe lists the skills found and what was skipped. */
	describe() {
		const [list, problems] = this.scan();
		let b = '';
		if (!list.length) b += `No skills found. Put skill directories, each with a SKILL.md, in ${this.roots.join(' or ')}.\n`;
		else {
			b += '| Skill | Description | Directory |\n| --- | --- | --- |\n';
			for (const s of list) b += `| ${cell(s.name)} | ${cell(s.description)} | ${cell(s.dir)} |\n`;
		}
		if (problems.length) {
			b += '\n**Warnings**\n\n';
			for (const p of problems) b += `- ${p.dir}: ${p.message}\n`;
		}
		return b;
	}
}

/** copies is where loaded skills are copied in a sandbox workspace. */
const copies = '.mob/skills';
const cell = (text: string) => text.split(/\s+/).filter(Boolean).join(' ').replaceAll('|', '\\|');

/**
 * read parses dir's SKILL.md. A skill whose name differs from its directory's
 * loads with a warning, as other clients' skills often do; one without a
 * usable name or a description is skipped.
 */
function read(dir: string): [Skill, string] {
	const [meta] = split(readText(dir, 'SKILL.md'));
	const s: Skill = { name: str(meta.name), description: str(meta.description).trim(), compatibility: str(meta.compatibility) || undefined, dir };
	if (!s.description) throw new Error('skipped: SKILL.md has no description');
	if (!validName.test(s.name) || s.name.length > 64) throw new Error(`skipped: name ${JSON.stringify(s.name)} must be up to 64 lowercase letters, digits and single hyphens`);
	if (s.description.length > 1024) s.description = s.description.slice(0, 1024);
	return [s, s.name !== basename(dir) ? `name ${JSON.stringify(s.name)} differs from its directory` : ''];
}

/** split separates SKILL.md's YAML frontmatter from its body. */
export function split(data: string): [Record<string, unknown>, string] {
	data = data.replaceAll('\r\n', '\n').replace(/^﻿/, '');
	if (!data.startsWith('---\n')) throw new Error('skipped: SKILL.md does not start with --- frontmatter');
	const rest = data.slice(4);
	const end = rest.indexOf('\n---');
	if (end < 0) throw new Error('skipped: SKILL.md frontmatter is not closed with ---');
	const front = rest.slice(0, end);
	// The closing line may carry trailing spaces; the body starts after it.
	let body = rest.slice(end + 4);
	const nl = body.indexOf('\n');
	body = nl < 0 ? '' : body.slice(nl + 1);
	let meta: unknown;
	try { meta = Bun.YAML.parse(front); } catch {
		// Skills written for other clients often leave a colon unquoted, as in "description: Use when: ...".
		try { meta = Bun.YAML.parse(quote(front)); } catch { throw new Error('skipped: SKILL.md frontmatter is not YAML'); }
	}
	return [meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : {}, body.trim()];
}

/** quote turns each top-level "key: value" whose value holds a colon into a block scalar. */
function quote(front: string) {
	return front.split('\n').map(line => {
		const i = line.indexOf(': ');
		if (i < 0) return line;
		const key = line.slice(0, i), value = line.slice(i + 2);
		if (!key || /[ \t"']/.test(key) || !value.includes(':') || /^["'|>]/.test(value)) return line;
		return `${key}: |-\n  ${value}`;
	}).join('\n');
}

const str = (v: unknown) => typeof v === 'string' ? v : '';

/** readText reads a text file of at most maxText bytes inside dir; name may not lead out of it, through links either. */
export function readText(dir: string, name: string) {
	const root = realpathSync(dir);
	const path = realpathSync(join(root, name));
	if (path !== root && !path.startsWith(root + sep)) throw new Error(`${name} is outside the skill`);
	const fd = openSync(path, 'r');
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error(`${name} is not a file`);
		if (info.size > maxText) throw new Error(`${name} is ${info.size} bytes, over the ${maxText} a skill file may have`);
		const data = readFileSync(fd);
		if (data.length > maxText) throw new Error(`${name} exceeds ${maxText} bytes`);
		try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error(`${name} is not text`); }
	} finally { closeSync(fd); }
}

/** files lists the skill's regular files other than SKILL.md, relative to its directory, skipping hidden entries. */
function files(dir: string): [string[], boolean] {
	const list: string[] = [];
	const walk = (rel: string): boolean => {
		let entries;
		try { entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1); } catch { return false; }
		for (const e of entries) {
			if (e.name.startsWith('.') || e.name === 'node_modules') continue;
			const path = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) { if (walk(path)) return true; continue; }
			if (!e.isFile() || path === 'SKILL.md') continue;
			if (list.length === maxListed) return true;
			list.push(path);
		}
		return false;
	};
	const more = walk('');
	return [list, more];
}
