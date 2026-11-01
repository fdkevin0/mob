// Small stroke icons for the workspace, from Lucide; they inherit the text colour and are hidden from screen readers.
import { ArrowLeftRight, ArrowRight, ArrowUp, ArrowUpRight, Brain, ChartLine, Check, ChevronDown, ChevronRight, ChevronsUpDown, CircleAlert, Copy, Ellipsis, Eye, File, FoldVertical, Globe, Hand, House, Info, KeyRound, LayoutGrid, Menu, MessageSquare, Monitor, Pencil, Plug, Plus, RefreshCw, Search, Sparkles, Square, SquarePen, Terminal, Trash2, TriangleAlert, User, Wrench, X, type LucideIcon } from 'lucide-react';

const icon = (Lucide: LucideIcon, size: number) => () => <Lucide aria-hidden="true" size={size} strokeWidth={2} />;

export const StopIcon = () => <Square aria-hidden="true" size={14} fill="currentColor" />;
export const SpinnerIcon = () => <span className="spinner" aria-hidden="true" />;
export const ArrowUpIcon = icon(ArrowUp, 16);
export const ArrowRightIcon = icon(ArrowRight, 14);
export const PlusIcon = icon(Plus, 16);
export const CheckIcon = icon(Check, 14);
export const CrossIcon = icon(X, 14);
export const ChevronIcon = icon(ChevronRight, 14);
export const ChevronDownIcon = icon(ChevronDown, 14);
export const HandIcon = icon(CircleAlert, 14);
export const CopyIcon = icon(Copy, 14);
export const TerminalIcon = icon(Terminal, 12);
export const PencilIcon = icon(Pencil, 12);
export const FileIcon = icon(File, 12);
export const SearchIcon = icon(Search, 12);
export const GlobeIcon = icon(Globe, 12);
export const SparkIcon = icon(Sparkles, 12);
export const AlertIcon = icon(TriangleAlert, 12);
export const OpenIcon = icon(ArrowUpRight, 12);
export const MessageIcon = icon(MessageSquare, 12);
export const ComposeIcon = icon(SquarePen, 16);
export const MenuIcon = icon(Menu, 20);
export const AgentsIcon = icon(LayoutGrid, 16);
export const ChartIcon = icon(ChartLine, 16);
export const KeyIcon = icon(KeyRound, 16);
export const PlugIcon = icon(Plug, 16);
export const MoveIcon = icon(ArrowRight, 16);
export const InfoIcon = icon(Info, 16);
export const HomeIcon = icon(House, 16);
export const UserIcon = icon(User, 16);
export const RunnerIcon = icon(Monitor, 16);
export const BrowserIcon = icon(Globe, 16);
export const SwitchIcon = icon(ArrowLeftRight, 16);
export const ChevronsIcon = icon(ChevronsUpDown, 14);
export const RaisedHandIcon = icon(Hand, 14);
export const MoreIcon = icon(Ellipsis, 16);
export const RenameIcon = icon(Pencil, 16);
export const TrashIcon = icon(Trash2, 16);
export const CompactIcon = icon(FoldVertical, 14);
export const RetryIcon = icon(RefreshCw, 16);
export const BrainIcon = icon(Brain, 14);
export const EyeIcon = icon(Eye, 14);
export const WrenchIcon = icon(Wrench, 14);

// Brand marks of cloud hosts, in one colour so they sit with the workspace's own icons. Paths come from
// Simple Icons (CC0); the marks remain their owners' trademarks and only name the host a button opens.
export const RenderLogo = () => (
	<svg aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
		<path d="M18.263.007c-3.121-.147-5.744 2.109-6.192 5.082-.018.138-.045.272-.067.405-.696 3.703-3.936 6.507-7.827 6.507-1.388 0-2.691-.356-3.825-.979a.2024.2024 0 0 0-.302.178V24H12v-8.999c0-1.656 1.338-3 2.987-3h2.988c3.382 0 6.103-2.817 5.97-6.244-.12-3.084-2.61-5.603-5.682-5.75" />
	</svg>
);
