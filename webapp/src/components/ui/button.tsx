import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../../lib/utils';

export function Button({
	className,
	variant = 'primary',
	asChild = false,
	...props
}: ComponentProps<'button'> & {
	variant?: 'primary' | 'outline' | 'ghost';
	asChild?: boolean;
}) {
	const Component = asChild ? Slot : 'button';
	return <Component data-slot="button" className={cn(`btn btn-${variant}`, className)} {...props} />;
}
