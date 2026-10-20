// Copies the repository's Markdown into Starlight's content directory before a
// build. The repository files stay the single source and keep reading well on
// GitHub: each page's first `# Heading` becomes its frontmatter title, links
// between pages become site routes, and links to anything else in the
// repository point at GitHub.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { pages, repositoryUrl, type Page } from '../pages';

const docsRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(docsRoot, '../..');
const contentDir = join(docsRoot, 'src/content/docs');
const mediaDir = join(docsRoot, 'public/media');
const base = '/docs';

const routes = new Map(pages.map((page) => [page.source, page.slug]));
// Links to the docs index on GitHub land on the site's front page.
routes.set('docs/README.md', '');

if (import.meta.main) {
	const unlisted = readdirSync(join(repoRoot, 'docs'), { recursive: true })
		.map((entry) => `docs/${String(entry).split('\\').join('/')}`)
		.filter((file) => file.endsWith('.md') && !routes.has(file));
	if (unlisted.length) throw new Error(`Add ${unlisted.join(', ')} to apps/docs/pages.ts`);

	rmSync(contentDir, { recursive: true, force: true });
	rmSync(mediaDir, { recursive: true, force: true });
	for (const page of pages) {
		const target = join(contentDir, page.slug === '' ? 'index.md' : `${page.slug}.md`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, convert(readFileSync(join(repoRoot, page.source), 'utf8'), page));
	}
}

export function convert(markdown: string, page: Page): string {
	const lines = markdown.split('\n');
	const heading = lines.findIndex((line) => line.startsWith('# '));
	if (heading === -1) throw new Error(`${page.source} has no "# " heading`);
	const title = page.title ?? lines[heading].slice(2).trim();
	lines.splice(heading, 1);
	let fence = '';
	const body = lines.map((line) => {
		const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
		if (marker && (!fence || marker.startsWith(fence))) {
			fence = fence ? '' : marker;
			return line;
		}
		return fence ? line : rewriteLinks(line, page);
	});
	const frontmatter = ['---', `title: ${JSON.stringify(title)}`];
	if (page.description) frontmatter.push(`description: ${JSON.stringify(page.description)}`);
	frontmatter.push(`editUrl: ${JSON.stringify(`${repositoryUrl}/edit/main/${page.editSource ?? page.source}`)}`, '---');
	return `${frontmatter.join('\n')}\n${body.join('\n').replace(/^\n+/, '\n')}`;
}

// Rewrites inline links and images (with or without a title), reference
// definitions and raw HTML href/src attributes, leaving inline code alone.
export function rewriteLinks(line: string, page: Page): string {
	const definition = line.match(/^(\s{0,3}\[[^\]]+\]:\s+)(\S+)(.*)$/);
	if (definition) return definition[1] + resolveHref(definition[2], page, false) + definition[3];
	// Inline code is set aside first, so `[a](b.md)` in code stays as written
	// while [`code`](b.md) is still a link.
	const code: string[] = [];
	return line
		.replace(/`+[^`]*`+/g, (span) => `\0${code.push(span) - 1}\0`)
		.replace(/(!?)(\[[^\]]*\])\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, image: string, text: string, href: string, title: string) =>
			`${image}${text}(${resolveHref(href, page, !!image)}${title})`,
		)
		.replace(/\b(href|src)="([^"]+)"/g, (_, name: string, href: string) => `${name}="${resolveHref(href, page, name === 'src')}"`)
		.replace(/\0(\d+)\0/g, (_, index: string) => code[Number(index)]);
}

function resolveHref(href: string, page: Page, image: boolean): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
	const [path, fragment] = splitFragment(href);
	const file = posix.normalize(posix.join(posix.dirname(page.source), path));
	if (file.startsWith('..')) throw new Error(`${page.source} links outside the repository: ${href}`);
	if (!existsSync(join(repoRoot, file))) throw new Error(`${page.source} links to missing ${file}`);
	if (image) return media(file) + fragment;
	const slug = routes.get(file);
	if (slug !== undefined) return route(slug) + fragment;
	const kind = statSync(join(repoRoot, file)).isDirectory() ? 'tree' : 'blob';
	return `${repositoryUrl}/${kind}/main/${file}${fragment}`;
}

function splitFragment(href: string): [string, string] {
	const at = href.indexOf('#');
	return at === -1 ? [href, ''] : [href.slice(0, at), href.slice(at)];
}

function route(slug: string): string {
	return slug === '' ? `${base}/` : `${base}/${slug}/`;
}

function media(file: string): string {
	const target = join(mediaDir, file);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(join(repoRoot, file), target);
	return `${base}/media/${relative(mediaDir, target).split('\\').join('/')}`;
}
