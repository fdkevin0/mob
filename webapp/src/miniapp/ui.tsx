import { useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactElement, type ReactNode } from 'react';

const buttonVariants = {
	default: 'border border-separator bg-surface',
	primary: 'bg-primary text-on-primary',
	danger: 'border border-danger text-danger',
	plain: 'text-primary',
};

/** Native buttons retain form validation; pending clicks cannot submit twice. */
export function Button({ variant = 'default', loading = false, loadingText, disabled, className = '', children, onClick, type = 'button', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
	variant?: keyof typeof buttonVariants;
	loading?: boolean;
	loadingText?: string;
	onClick?: (event: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
}): ReactElement {
	const [pending, setPending] = useState(false);
	const clicking = useRef(false);
	const busy = loading || pending;
	return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy}
		className={`min-h-11 rounded-xl px-4 py-2 font-medium enabled:active:opacity-75 disabled:cursor-default disabled:opacity-50 ${buttonVariants[variant]} ${className}`}
		onClick={async (event) => {
			if (!onClick || clicking.current) return;
			clicking.current = true;
			try {
				const result = onClick(event);
				if (result) { setPending(true); await result; }
			} finally { clicking.current = false; setPending(false); }
		}}>{busy && loadingText ? loadingText : children}</button>;
}

export function List({ header, children }: { header?: ReactNode; children: ReactNode }): ReactElement {
	return <section className="mb-4">
		{header && <div className="px-1 pt-3 pb-2 text-sm text-muted">{header}</div>}
		<div className="divide-y divide-separator rounded-xl bg-surface">{children}</div>
	</section>;
}

List.Item = function ListItem({ description, extra, children }: { description?: ReactNode; extra?: ReactNode; children: ReactNode }): ReactElement {
	return <div className="flex items-center gap-3 px-4 py-3">
		<div className="min-w-0 flex-1 wrap-anywhere">{children}{description && <div className="mt-1 text-sm text-muted">{description}</div>}</div>
		{extra && <div className="shrink-0">{extra}</div>}
	</div>;
};
