import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import './notice.css';

// Line icons for the four tones, drawn like the workspace's own (Lucide paths, ISC).
const icons = {
	error: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 8v4M12 16h.01" />
		</>
	),
	warning: (
		<>
			<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
			<path d="M12 9v4M12 17h.01" />
		</>
	),
	info: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 16v-4M12 8h.01" />
		</>
	),
	success: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="m8 12 3 3 5-6" />
		</>
	),
};

export type NoticeTone = keyof typeof icons;

/**
 * Notice is every message Mob puts in a page about what happened: a failure, a
 * warning, a note or a success. It is a tinted card with a line icon, an
 * optional title and the actions that resolve it, in either theme. Errors are
 * announced at once (role alert); the other tones politely (role status),
 * without the actions' labels.
 */
export function Notice({
	tone = 'info',
	title,
	children,
	actions,
	size,
	className,
	role,
	...rest
}: {
	tone?: NoticeTone;
	title?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	/** sm fits a notice inside a list, a card or a menu. */
	size?: 'sm';
	className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'>) {
	return (
		<div {...rest} className={cn('notice', className)} data-tone={tone} data-size={size}>
			<svg className="notice-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				{icons[tone]}
			</svg>
			<div className="notice-body" role={role ?? (tone === 'error' ? 'alert' : 'status')}>
				{title && <strong className="notice-title">{title}</strong>}
				{children && <div className="notice-text">{children}</div>}
			</div>
			{actions && <div className="notice-actions">{actions}</div>}
		</div>
	);
}
