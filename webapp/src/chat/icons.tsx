import type { ReactNode } from 'react';

// Small stroke icons for the workspace; they inherit the text colour and are hidden from screen readers.
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{children}
		</svg>
	);
}

export const ArrowUpIcon = () => (
	<Icon>
		<path d="M12 19V5M5 12l7-7 7 7" />
	</Icon>
);
export const StopIcon = () => (
	<Icon size={14}>
		<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
	</Icon>
);
export const PlusIcon = () => (
	<Icon>
		<path d="M12 5v14M5 12h14" />
	</Icon>
);
export const CheckIcon = () => (
	<Icon size={14}>
		<path d="M20 6 9 17l-5-5" />
	</Icon>
);
export const CrossIcon = () => (
	<Icon size={14}>
		<path d="M18 6 6 18M6 6l12 12" />
	</Icon>
);
export const ChevronIcon = () => (
	<Icon size={14}>
		<path d="m9 18 6-6-6-6" />
	</Icon>
);
export const ChevronDownIcon = () => (
	<Icon size={14}>
		<path d="m6 9 6 6 6-6" />
	</Icon>
);
export const HandIcon = () => (
	<Icon size={14}>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 8v4M12 16h.01" />
	</Icon>
);
export const CopyIcon = () => (
	<Icon size={14}>
		<rect x="9" y="9" width="12" height="12" rx="2" />
		<path d="M5 15V5a2 2 0 0 1 2-2h10" />
	</Icon>
);
export const SpinnerIcon = () => <span className="spinner" aria-hidden="true" />;
