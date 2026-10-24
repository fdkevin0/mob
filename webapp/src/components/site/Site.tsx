import type { ReactNode } from 'react';
import { Logo } from '../brand/Logo';
import { ThemePicker } from '../../theme/ThemePicker';
import './site.css';

export type SiteLink = { href: string; label: string; current?: boolean };

const github = 'https://github.com/fdkevin0/mob';

// The header every public page shares: the calf, the page's links, the theme
// and whatever account actions the page offers. The landing and the demo float
// it over their stage; other pages keep it stuck to the top.
export function SiteHeader({ links, floating, children }: { links: SiteLink[]; floating?: boolean; children?: ReactNode }) {
	return (
		<header className={floating ? 'nav nav-floating' : 'nav'}><div className="nav-inner">
			<a href="/" className="brand" aria-label="Mob home"><Logo /></a>
			<nav className="nav-links" aria-label="Sections">
				{links.map(link => <a key={link.href} href={link.href} aria-current={link.current ? 'page' : undefined}>{link.label}</a>)}
				<a href={github} rel="noreferrer">GitHub</a>
			</nav>
			<ThemePicker className="nav-theme" />
			<div className="nav-account">{children}</div>
		</div></header>
	);
}

export function SiteFooter({ links }: { links: SiteLink[] }) {
	return (
		<footer className="footer">
			<div className="footer-brand"><Logo size={20} /><span>MIT licensed</span></div>
			<nav aria-label="Project links">
				{links.map(link => <a key={link.href} href={link.href} rel={link.href.startsWith('http') ? 'noreferrer' : undefined}>{link.label}</a>)}
				<a href={`${github}/releases`} rel="noreferrer">Releases</a>
				<a href={github} rel="noreferrer">GitHub</a>
			</nav>
		</footer>
	);
}
