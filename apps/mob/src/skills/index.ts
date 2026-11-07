// The skills plugin: the skill tool, /skills, and tool_search entries beyond the prompt's list.
import { z } from 'zod';
import { body, defineTool, HTTPError, interactive, type Entry, type Plugin, type Tool } from '@mob/core';
import { join } from 'node:path';
import type { HostPlugin } from '../local';
import { sandboxOf } from '../sandbox';
import { Library, roots } from './skills';
import { SkillMarket, installInput, nameInput, repositoryInput, sourceInput } from './market';

/** listed is how many skills the system prompt names; beyond it, the model finds them with tool_search. */
const listed = 20;

/** entries are the skills found now, for tool_search to find; none while the system prompt names them all. */
function entries(l: Library): Entry[] {
	const [list] = l.scan();
	if (list.length <= listed) return [];
	return list.map(s => ({ kind: 'skill', name: s.name, description: s.description, use: `Call the skill tool with name ${JSON.stringify(s.name)}.`, ownerOnly: true }));
}

/** tools is the skill tool, listing the skills found now; none while there are none. */
function tools(l: Library): Tool[] {
	const [list] = l.scan();
	if (!list.length) return [];
	const many = list.length > listed;
	let catalog = "Skills are task instructions the owner installed. When a task matches a skill's description, call the skill tool with its name before starting and follow what it returns.";
	// Many skills are found with tool_search instead of filling the prompt.
	if (many) catalog += ` ${list.length} skills are installed; find the ones a task needs with tool_search.`;
	else catalog += ' <available_skills>' + list.map(s => `<skill><name>${s.name}</name><description>${Bun.escapeHTML(s.description)}</description></skill>`).join('') + '</available_skills>';
	const names = list.map(s => s.name);
	return [defineTool({
		name: 'skill',
		description: "Load a skill's instructions by name, or read one of its files by its path relative to the skill.",
		input: z.object({
			name: many || !names.length ? z.string().describe("The skill's name, as tool_search gave it") : z.enum(names as [string, ...string[]]),
			path: z.string().optional().describe('A file in the skill, such as references/guide.md; omit it to load SKILL.md.'),
		}),
		prompt: catalog,
		ownerOnly: true,
		run: async call => {
			const { name, path: file = '' } = call.input;
			const s = l.find(name);
			if (!s) throw new Error(`no skill is named ${JSON.stringify(name)}`);
			return file ? l.readFile(s, file) : l.load(s, call.conversationId);
		},
	})];
}

function plugin(l: Library, market: SkillMarket): Plugin {
	// Finish before the client's 60-second timeout, and cancel when its request ends.
	const signal = (req: Request) => AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]);
	const parse = async <T>(req: Request, schema: z.ZodType<T>, keys: string[]) => {
		const r = schema.safeParse(await body(req, undefined, keys));
		if (!r.success) throw new HTTPError(400, r.error.issues[0]?.message ?? 'invalid request');
		return r.data;
	};
	return {
		name: 'skills',
		routes: [
			{ method: 'GET', path: 'installed', handle: async () => market.overview() },
			{ method: 'POST', path: 'check', handle: async req => market.overview(true, signal(req)) },
			{ method: 'POST', path: 'discover', handle: async req => market.discover(await parse(req, repositoryInput, ['source', 'ref']), signal(req)) },
			{ method: 'POST', path: 'preview', handle: async req => market.preview(await parse(req, sourceInput, ['source', 'ref', 'skillPath']), undefined, signal(req)) },
			{ method: 'POST', path: 'install', handle: async req => market.install(await parse(req, installInput, ['source', 'ref', 'skillPath', 'commit']), signal(req)) },
			{ method: 'POST', path: 'remove', handle: async req => market.remove((await parse(req, nameInput, ['name'])).name) },
			{ method: 'POST', path: 'read', handle: async req => {
				const skill = l.find((await parse(req, nameInput, ['name'])).name);
				if (!skill) throw new HTTPError(404, 'Skill not found');
				return { content: l.readFile(skill, 'SKILL.md') };
			} },
		],
		commands: [{ name: 'skills', usage: '/skills', summary: 'Show the skills the model can load', clients: interactive, ownerOnly: true, run: async () => ({ markdown: l.describe() }) }],
		source: () => tools(l),
		entries: () => entries(l),
	};
}

export const skillsPlugin: HostPlugin = {
	attach(e, server) {
		const library = new Library(roots(e.dir), id => sandboxOf(server)?.workspace(id) ?? '');
		return [plugin(library, new SkillMarket(library, join(e.dir, '.skill-lock.json')))];
	},
};
