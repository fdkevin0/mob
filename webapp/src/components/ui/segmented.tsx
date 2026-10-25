import { cn } from '../../lib/utils';

export type Segment<T extends string> = { value: T; label: string };

// A row of mutually exclusive choices in one rounded track, like the theme
// picker. As tabs it labels a panel (aria-selected); otherwise each choice is
// a toggle button (aria-pressed).
export function Segmented<T extends string>({ label, options, value, onChange, tabs, className }: {
	label: string;
	options: Segment<T>[];
	value: T;
	onChange: (value: T) => void;
	tabs?: boolean;
	className?: string;
}) {
	return (
		<div role={tabs ? 'tablist' : 'group'} aria-label={label} className={cn('ui-segmented', className)}>
			{options.map(option => (
				<button
					key={option.value}
					type="button"
					role={tabs ? 'tab' : undefined}
					aria-selected={tabs ? value === option.value : undefined}
					aria-pressed={tabs ? undefined : value === option.value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
