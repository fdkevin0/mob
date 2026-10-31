// The pages of https://usemob.app/docs, in sidebar order. Each comes
// from a Markdown file in the repository (scripts/sync.ts copies it in), so a
// new page under docs/ needs an entry here to appear on the site.
export const repositoryUrl = 'https://github.com/fdkevin0/mob';

/** Sidebar groups, in order: start, everyday use, then deeper and deeper. */
export const groups = ['Start', 'Use', 'Coding agents', 'Extend', 'Remote access', 'Reference', 'Contributing'] as const;

export interface Page {
	/** Repository path of the Markdown file. */
	source: string;
	/** Route below /docs/; '' is the front page. */
	slug: string;
	group: (typeof groups)[number];
	/** Overrides the file's `# Heading`. */
	title?: string;
	description?: string;
	/** The file "Edit page" opens, when the page is generated from it. */
	editSource?: string;
}

const feature = (group: Page['group'], ...names: string[]): Page[] =>
	names.map((name) => ({ source: `docs/features/${name}.md`, slug: `features/${name}`, group }));

export const pages: Page[] = [
	{
		source: 'README.md',
		slug: '',
		group: 'Start',
		title: 'Mob',
		description: 'A personal AI assistant that runs on your own machine.',
	},
	{ source: 'docs/install.md', slug: 'install', group: 'Start', description: 'Install Mob with npm or Bun.' },
	{ source: 'docs/features/README.md', slug: 'features', group: 'Start', title: 'All features' },
	...feature('Use', 'providers', 'configuration', 'turns-and-context', 'tools-and-approvals', 'sandbox', 'commands', 'schedules', 'desktop'),
	...feature('Coding agents', 'coding-agents', 'task-workflow', 'plans'),
	...feature('Extend', 'channels', 'plugins', 'mcp', 'skills', 'deepseek-harness', 'extensions'),
	...feature('Remote access', 'remote-access', 'browser-runner', 'cloud-runners'),
	{
		source: 'docs/environment-variables.md',
		slug: 'reference/configuration',
		group: 'Reference',
		title: 'Configuration keys',
		editSource: 'apps/mob/src/config.ts',
	},
	...feature('Reference', 'releases'),
	{ source: 'CONTRIBUTING.md', slug: 'contributing', group: 'Contributing' },
	{ source: 'docs/architecture.md', slug: 'contributing/architecture', group: 'Contributing' },
	{ source: 'docs/website.md', slug: 'contributing/website', group: 'Contributing' },
	{ source: 'docs/ui-style.md', slug: 'contributing/ui-style', group: 'Contributing' },
	{ source: 'docs/screenshots.md', slug: 'contributing/screenshots', group: 'Contributing' },
	{ source: 'docs/prompt-evals.md', slug: 'contributing/prompt-evals', group: 'Contributing' },
	{ source: 'docs/sandbox-verification.md', slug: 'contributing/sandbox-verification', group: 'Contributing' },
];
