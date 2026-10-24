import type { ReactNode } from 'react';
import { Calf } from '../components/brand/Logo';
import { SpinnerIcon } from './icons';

/** Splash fills the window while Mob connects or the workspace opens: the calf, and what is happening. */
export function Splash({ label, children }: { label: string; children?: ReactNode }) {
	return (
		<main className="splash">
			<Calf size={48} className="splash-calf" />
			{children ?? (
				<p className="splash-label" role="status">
					<SpinnerIcon />
					{label}
				</p>
			)}
		</main>
	);
}

/** Loading fills a page or a panel while it loads. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
	return (
		<div className="loading" role="status">
			<SpinnerIcon />
			{label}
		</div>
	);
}
