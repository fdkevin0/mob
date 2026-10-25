import { Logo } from '../brand/Logo';
import { ThemePicker } from '../../theme/ThemePicker';
import type { MouseEventHandler } from 'react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from '../ui/dialog';
import { siteLinks } from './navigation';
import { UserMenu } from '../../landing/UserMenu';
import './header.css';
import './site.css';

export type SiteLink = { href: string; label: string };

const github = 'https://github.com/fdkevin0/mob';

// React and Astro render the same navigation data and use header.css.
export function SiteHeader({ current, floating, onSignIn }: { current?: string; floating?: boolean; onSignIn?: MouseEventHandler<HTMLButtonElement> }) {
	return (
		<header className={`site-header${floating ? ' site-header-floating' : ''}`}><div className="site-header-inner">
			<Dialog>
				<DialogTrigger className="site-menu-button" aria-label="Open navigation"><span aria-hidden="true">☰</span></DialogTrigger>
				<DialogContent className="site-drawer" aria-describedby={undefined}>
					<DialogTitle>Navigation</DialogTitle>
					<a className="site-drawer-search" href="/docs/?search">Search docs</a>
					<nav className="site-drawer-links" aria-label="Site">
						{siteLinks.map(link => <a key={link.href} href={link.href} aria-current={link.href === current ? 'page' : undefined}>{link.label}</a>)}
					</nav>
					<div className="site-drawer-theme"><ThemePicker /></div>
				</DialogContent>
			</Dialog>
			<a href="/" className="site-brand" aria-label="Mob home"><Logo /></a>
			<nav className="site-links" aria-label="Site">
				{siteLinks.map(link => <a key={link.href} href={link.href} aria-current={link.href === current ? 'page' : undefined}>{link.label}</a>)}
			</nav>
			<div className="site-theme"><ThemePicker /></div>
			<div className="site-account">
				<a href="/app">Open Mob</a>
				<UserMenu onSignIn={onSignIn} />
			</div>
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
