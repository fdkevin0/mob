import type { ReactNode } from 'react';

// Line icons for the landing, sign-in and account pages, drawn like the workspace's own (stroke icons on a
// 24px grid). Paths follow Lucide (ISC). Only the calves stay pixel art.
const icons = {
	terminal: (
		<>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<path d="m7 11 2-2-2-2M11 13h4" />
		</>
	),
	channels: (
		<>
			<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
			<path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
		</>
	),
	shield: (
		<>
			<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
			<path d="m9 12 2 2 4-4" />
		</>
	),
	box: (
		<>
			<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
			<path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
		</>
	),
	memory: (
		<>
			<ellipse cx="12" cy="5" rx="9" ry="3" />
			<path d="M3 5v14a9 3 0 0 0 18 0V5" />
			<path d="M3 12a9 3 0 0 0 18 0" />
		</>
	),
	plug: (
		<>
			<path d="M12 22v-5M9 8V2M15 8V2" />
			<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
		</>
	),
	tree: (
		<>
			<rect x="16" y="16" width="6" height="6" rx="1" />
			<rect x="2" y="16" width="6" height="6" rx="1" />
			<rect x="9" y="2" width="6" height="6" rx="1" />
			<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
		</>
	),
	clock: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 6v6l4 2" />
		</>
	),
	code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
	search: (
		<>
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.3-4.3" />
		</>
	),
	lock: (
		<>
			<rect x="3" y="11" width="18" height="11" rx="2" />
			<path d="M7 11V7a5 5 0 0 1 10 0v4" />
		</>
	),
	key: (
		<>
			<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
			<circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
		</>
	),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
	return (
		<svg
			className={className}
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={size > 20 ? 1.5 : 1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{icons[name]}
		</svg>
	);
}
