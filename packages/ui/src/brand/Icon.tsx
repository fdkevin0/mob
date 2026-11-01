// Line icons for the landing, sign-in and account pages, from Lucide like the workspace's own. Only the calves stay pixel art.
import { Box, Clock, Code, Database, KeyRound, Lock, MessagesSquare, Network, Plug, Search, ShieldCheck, SquareTerminal, type LucideIcon } from 'lucide-react';

const icons = {
	terminal: SquareTerminal, channels: MessagesSquare, shield: ShieldCheck, box: Box, memory: Database, plug: Plug,
	tree: Network, clock: Clock, code: Code, search: Search, lock: Lock, key: KeyRound,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
	const Lucide = icons[name];
	return <Lucide className={className} aria-hidden="true" size={size} strokeWidth={size > 20 ? 1.5 : 1.75} />;
}
