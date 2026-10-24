import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Library } from '../src/skills/skills';

const temp = () => mkdtempSync(join(tmpdir(), 'skills-'));
function write(path: string, text: string, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	chmodSync(path, mode);
}

test('scan parses, shadows and warns', () => {
	const mine = temp(), shared = temp();
	write(join(mine, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Fill PDF forms.\n---\n# PDF\n');
	write(join(shared, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Another.\n---\nbody');
	write(join(shared, 'review', 'SKILL.md'), '﻿---\r\nname: code-review\r\ndescription: Use when: the user asks for a review\r\n---\r\nReview.');
	write(join(shared, 'empty', 'SKILL.md'), '---\nname: empty\n---\nbody');
	write(join(shared, 'Bad', 'SKILL.md'), '---\nname: Bad\ndescription: x\n---\n');
	write(join(shared, 'plain', 'README.md'), 'not a skill');
	const [list, problems] = new Library([mine, shared, join(temp(), 'missing')]).scan();
	expect(list.map(s => s.name)).toEqual(['pdf', 'code-review']);
	expect(list[1]!.description).toBe('Use when: the user asks for a review');
	const text = problems.map(p => `${p.dir}: ${p.message}`).join('\n');
	for (const want of ['already offered from ' + join(mine, 'pdf'), '"code-review" differs from its directory', 'has no description', 'name "Bad"']) expect(text).toContain(want);
	expect(text).not.toContain('missing');
	expect(text).not.toContain('plain');
});

test('load copies the skill into the workspace and reads files inside it only', () => {
	const root = temp(), workspace = temp(), outside = temp();
	const dir = join(root, 'pdf');
	write(join(dir, 'SKILL.md'), '---\nname: pdf\ndescription: Fill forms.\ncompatibility: Requires Python\n---\n# PDF\nRun scripts/fill.py.\n');
	write(join(dir, 'scripts', 'fill.py'), "print('ok')\n", 0o700);
	write(join(dir, 'references', 'forms.md'), 'Forms guide');
	write(join(dir, '.git', 'HEAD'), 'ref');
	write(join(outside, 'secret'), 'secret');
	symlinkSync(join(outside, 'secret'), join(dir, 'leak'));
	const l = new Library([root], () => workspace);
	const s = l.find('pdf')!;
	const out = l.load(s, 'abc123');
	expect(out).toContain('<skill_content name="pdf">\n# PDF\nRun scripts/fill.py.\n</skill_content>');
	expect(out).toContain('Compatibility: Requires Python');
	expect(out).toContain('Files in the skill: references/forms.md, scripts/fill.py.');
	expect(out).toContain('copied to /workspace/.mob/skills/pdf');
	const copy = join(workspace, '.mob', 'skills', 'pdf');
	// Commands may run as another user than Mob's, so the copy is readable by all.
	expect(statSync(join(copy, 'scripts', 'fill.py')).mode & 0o777).toBe(0o755);
	expect(statSync(join(copy, 'references', 'forms.md')).mode & 0o777).toBe(0o644);
	expect(existsSync(join(copy, '.git'))).toBe(false);
	expect(existsSync(join(copy, 'leak'))).toBe(false);
	expect(l.readFile(s, 'references/forms.md')).toBe('Forms guide');
	expect(() => l.readFile(s, '../pdf/SKILL.md')).toThrow('relative');
	expect(() => l.readFile(s, 'leak')).toThrow('outside');
	// Loading again replaces the copy; without a sandbox scripts cannot run.
	l.load(s, 'abc123');
	expect(new Library([root]).load(s, 'abc123')).toContain('sandbox is off');
});

test('a link planted in the workspace is not followed', () => {
	const root = temp(), workspace = temp(), outside = temp();
	write(join(root, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: x\n---\nbody');
	write(join(root, 'pdf', 'a.txt'), 'a');
	mkdirSync(join(workspace, '.mob'));
	symlinkSync(outside, join(workspace, '.mob', 'skills'));
	const l = new Library([root], () => workspace);
	expect(l.load(l.find('pdf')!, 'abc')).toContain('could not be copied');
	expect(existsSync(join(outside, 'pdf'))).toBe(false);
});
