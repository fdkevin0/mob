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
 * optional title and the actions that resolve it, in either theme. It shows
 * the gist first: what explains it further waits behind a "details" toggle
 * (progressive disclosure), and a notice that can go has a close button. Errors are
 * announced at once (role alert); the other tones politely (role status),
 * without the actions' labels.
 */
export function Notice({
	tone = 'info',
	title,
	children,
	actions,
	details,
	detailsLabel = 'Details',
	detailsOpen,
	onDismiss,
	size,
	className,
	role,
	...rest
}: {
	tone?: NoticeTone;
	title?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	/** details is shown only on request, under detailsLabel; detailsOpen opens it at first. */
	details?: ReactNode;
	detailsLabel?: string;
	detailsOpen?: boolean;
	onDismiss?: () => void;
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
				{details && (
					<details className="notice-details" open={detailsOpen}>
						<summary>
							{detailsLabel}
							<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="m6 9 6 6 6-6" />
							</svg>
						</summary>
						<div className="notice-text">{details}</div>
					</details>
				)}
			</div>
			{actions && <div className="notice-actions">{actions}</div>}
			{onDismiss && (
				<button type="button" className="notice-dismiss" aria-label="Dismiss" onClick={onDismiss}>
					<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M18 6 6 18M6 6l12 12" />
					</svg>
				</button>
			)}
		</div>
	);
}
