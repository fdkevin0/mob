import type { ComponentProps } from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/utils';
import './dropdown-menu.css';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuLabel = MenuPrimitive.Label;
export const DropdownMenuItem = MenuPrimitive.Item;

export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Content data-slot="dropdown-menu-content" align="end" sideOffset={8} className={cn('ui-menu', className)} {...props} />
		</MenuPrimitive.Portal>
	);
}
