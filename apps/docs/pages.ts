// The pages of https://usemob.app/docs, in sidebar order. Each comes
// from a Markdown file in the repository (scripts/sync.ts copies it in), so a
// new page under docs/ needs an entry here to appear on the site.
export const repositoryUrl = 'https://github.com/fdkevin0/mob';

export interface Page {
	/** Repository path of the Markdown file. */
	source: string;
	/** Route below /docs/; '' is the front page. */
	slug: string;
	group: 'Start' | 'Features' | 'Reference' | 'Contributing';
	/** Overrides the file's `# Heading`. */
	title?: string;
	description?: string;
	/** The file "Edit page" opens, when the page is generated from it. */
	editSource?: string;
}

const features = [
	'configuration',
	'providers',
	'turns-and-context',
	'tools-and-approvals',
	'sandbox',
	'commands',
	'channels',
	'plugins',
	'mcp',
	'deepseek-harness',
	'coding-agents',
	'plans',
	'schedules',
	'skills',
	'extensions',
	'desktop',
	'releases',
	'remote-access',
];

export const pages: Page[] = [
	{
		source: 'README.md',
		slug: '',
		group: 'Start',
		title: 'Mob',
		description: 'A personal AI assistant that runs on your own machine.',
	},
	{ source: 'docs/features/README.md', slug: 'features', group: 'Features', title: 'Overview' },
	...features.map((name): Page => ({ source: `docs/features/${name}.md`, slug: `features/${name}`, group: 'Features' })),
	{
		source: 'docs/environment-variables.md',
		slug: 'reference/configuration',
		group: 'Reference',
		title: 'Configuration keys',
		editSource: 'apps/mob/src/config.ts',
	},
	{ source: 'CONTRIBUTING.md', slug: 'contributing', group: 'Contributing' },
	{ source: 'docs/architecture.md', slug: 'contributing/architecture', group: 'Contributing' },
	{ source: 'docs/sandbox-verification.md', slug: 'contributing/sandbox-verification', group: 'Contributing' },
	{ source: 'docs/screenshots.md', slug: 'contributing/screenshots', group: 'Contributing' },
];
