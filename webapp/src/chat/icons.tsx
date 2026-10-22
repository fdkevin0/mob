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

// Brand marks of cloud hosts, in one colour so they sit with the workspace's own icons. Paths come from
// Simple Icons (CC0); the marks remain their owners' trademarks and only name the host a button opens.
export const RenderLogo = () => (
	<svg aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
		<path d="M18.263.007c-3.121-.147-5.744 2.109-6.192 5.082-.018.138-.045.272-.067.405-.696 3.703-3.936 6.507-7.827 6.507-1.388 0-2.691-.356-3.825-.979a.2024.2024 0 0 0-.302.178V24H12v-8.999c0-1.656 1.338-3 2.987-3h2.988c3.382 0 6.103-2.817 5.97-6.244-.12-3.084-2.61-5.603-5.682-5.75" />
	</svg>
);
export const TerminalIcon = () => (
	<Icon size={12}>
		<path d="m4 17 6-5-6-5M12 19h8" />
	</Icon>
);
export const PencilIcon = () => (
	<Icon size={12}>
		<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
	</Icon>
);
export const FileIcon = () => (
	<Icon size={12}>
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
		<path d="M14 2v6h6" />
	</Icon>
);
export const SearchIcon = () => (
	<Icon size={12}>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</Icon>
);
export const GlobeIcon = () => (
	<Icon size={12}>
		<circle cx="12" cy="12" r="9" />
		<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
	</Icon>
);
export const SparkIcon = () => (
	<Icon size={12}>
		<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
	</Icon>
);
export const AlertIcon = () => (
	<Icon size={12}>
		<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
		<path d="M12 9v4M12 17h.01" />
	</Icon>
);
export const OpenIcon = () => (
	<Icon size={12}>
		<path d="M7 17 17 7M8 7h9v9" />
	</Icon>
);
export const MessageIcon = () => (
	<Icon size={12}>
		<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
	</Icon>
);
