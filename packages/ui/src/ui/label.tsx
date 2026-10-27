import type { ComponentProps } from 'react';
import { cn } from '../utils';

export function Label({ className, ...props }: ComponentProps<'label'>) {
	return <label data-slot="label" className={cn('ui-label', className)} {...props} />;
}
