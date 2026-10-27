import type { ComponentProps } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../utils';

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
	return <TabsPrimitive.List data-slot="tabs-list" className={cn('ui-tabs-list', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
	return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn('ui-tabs-trigger', className)} {...props} />;
}
