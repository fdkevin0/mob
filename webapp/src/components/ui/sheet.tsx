import type { ComponentProps } from 'react';
import { DialogContent } from './dialog';
import { cn } from '../../lib/utils';

export { Dialog as Sheet, DialogTrigger as SheetTrigger, DialogTitle as SheetTitle, DialogDescription as SheetDescription } from './dialog';

export function SheetContent({ className, ...props }: ComponentProps<typeof DialogContent>) {
	return <DialogContent className={cn('sheet-panel', className)} {...props} />;
}
