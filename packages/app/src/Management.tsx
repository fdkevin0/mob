import { useEffect, useState } from 'react';
import { api, type Connection } from './api';
import type {
	CommandResult,
	CommandSpec,
	Memory,
	RememberedApproval,
	ScheduledPrompt,
	Projects,
	ProjectConfig,
} from './contracts';
import { Button } from '@mob/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mob/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mob/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@mob/ui/dropdown-menu';
import { MoreIcon } from './icons';
import './management.css';

const titles = {
	memories: 'Memories',
	grants: 'Remembered approvals',
	schedules: 'Schedules',
	projects: 'Projects',
};
export type ManagementTab = keyof typeof titles;
const paths = {
	memories: '/memories',
	grants: '/grants',
	schedules: '/plugins/schedules/list',
	projects: '/plugins/agents/projects',
};
type Data = {
	memories?: Memory[];
	grants?: RememberedApproval[];
	schedules?: ScheduledPrompt[];
	projects?: Projects;
};

export function Management({
	connection,
	tab,
	select,
	open,
	held,
}: {
	connection: Connection;
	tab: ManagementTab;
	select: (tab: ManagementTab) => void;
	open: (id: string) => void;
	held: (id: string) => boolean;
}) {
	return (
		<section className="page" aria-label="Manage Mob">
			<header className="view-header">
				<div className="view-header-inner wide">
					<h1>Manage Mob</h1>
				</div>
			</header>
			<div className="management">
				<Tabs className="management-layout" orientation="vertical" value={tab} onValueChange={(value) => select(value as ManagementTab)}>
					<div className="management-nav">
						<p className="management-nav-label">Workspace</p>
						<TabsList aria-label="Management sections">
							{Object.entries(titles).map(([key, title]) => (
								<TabsTrigger key={key} value={key}>
									{title}
								</TabsTrigger>
							))}
						</TabsList>
					</div>
					<label className="management-mobile-nav">
						Section
						<select className="ui-input" aria-label="Manage Mob" value={tab} onChange={(e) => select(e.target.value as ManagementTab)}>
							{Object.entries(titles).map(([key, title]) => (
								<option key={key} value={key}>
									{title}
								</option>
							))}
						</select>
					</label>
					<TabsContent className="management-content" value={tab}>
						<Contents key={tab} connection={connection} tab={tab} open={open} held={held} />
					</TabsContent>
				</Tabs>
			</div>
		</section>
	);
}

function Contents({
	connection,
	tab,
	open,
	held,
}: {
	connection: Connection;
	tab: ManagementTab;
	open: (id: string) => void;
	held: (id: string) => boolean;
}) {
	const [data, setData] = useState<Data>();
	const [available, setAvailable] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [revision, setRevision] = useState(0);
	const [confirmation, setConfirmation] = useState<{ text: string; run: () => Promise<unknown> }>();
	useEffect(() => {
		let live = true;
		setBusy(true);
		void (async () => {
			const commands = await api<CommandSpec[]>(connection, '/commands?client=web');
			const supported = commands.some((c) => c.name === tab);
			if (!live) return;
			setAvailable(supported);
			if (!supported) return;
			const result = await api(connection, paths[tab]);
			if (live) {
				setData({ [tab]: result });
				setError('');
			}
		})()
			.catch((e) => {
				if (live) setError(e.message);
			})
			.finally(() => {
				if (live) setBusy(false);
			});
		return () => {
			live = false;
		};
	}, [connection, tab, revision]);
	async function perform(run: () => Promise<unknown>) {
		setBusy(true);
		setError('');
		setNotice('');
		try {
			await run();
			setNotice('Done.');
			setConfirmation(undefined);
			setRevision((n) => n + 1);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	async function command(text: string) {
		const result = await api<CommandResult>(connection, '/commands/run', { client: 'web', text });
		if (!result.handled) throw new Error('This command is unavailable.');
		return result.markdown ?? 'Done.';
	}
	const conversation = (id: string) =>
		id && (
			<Button variant="ghost" disabled={held(id)} onClick={() => open(id)}>
				Open conversation
			</Button>
		);
	const remove = (path: string) => api(connection, path, {});
	const bulk = {
		memories: {
			count: data?.memories?.length,
			label: 'Delete all memories',
			text: 'Delete every saved memory across all conversations? This cannot be undone.',
			run: () => remove('/memories/all/delete'),
		},
		grants: {
			count: data?.grants?.length,
			label: 'Revoke all approvals',
			text: 'Revoke all remembered approvals? Matching tools will ask again.',
			run: () => remove('/grants/all/delete'),
		},
		schedules: {
			count: data?.schedules?.length,
			label: 'Cancel all schedules',
			text: 'Cancel every schedule across all conversations?',
			run: () => command('/unschedule all'),
		},
		projects: undefined,
	}[tab];
	return (
		<>
			<div className="management-heading">
				<h2>{titles[tab]}</h2>
				<div className="management-toolbar">
					<Button variant="ghost" disabled={busy} onClick={() => setRevision((n) => n + 1)}>
						Refresh
					</Button>
					{!!bulk?.count && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" aria-label="More actions" disabled={busy}>
									<MoreIcon />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuItem disabled={busy} onSelect={() => setConfirmation(bulk)}>
									{bulk.label}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</div>
			{error && <p role="alert">{error}</p>}
			{notice && <p role="status">{notice}</p>}
			{!available ? (
				<div className="management-empty">
					<h3>Connect a runner</h3>
					<p>This feature is not available on this Mob. Connect a runner that provides it.</p>
				</div>
			) : busy && !data ? (
				<p role="status">Loading…</p>
			) : null}
			{data?.memories && (
				<>
					<p>Facts Mob remembers. Ask Mob to remember a new fact.</p>
					{!data.memories.length && <p>No saved memories.</p>}
					{data.memories.map((m) => (
						<article className="management-card" key={m.id}>
							<p>{m.text}</p>
							<small>{m.owner ? 'All your conversations' : 'Only the conversation below'}</small>
							<div>
								{conversation(m.conversationId)}
								<Button
									variant="outline"
									disabled={busy}
									onClick={() =>
										setConfirmation({
											text: `Delete this memory? “${m.text}” cannot be restored.`,
											run: () => remove(`/memories/${m.id}/delete`),
										})
									}
								>
									Delete memory
								</Button>
							</div>
						</article>
					))}
				</>
			)}
			{data?.grants && (
				<>
					<p>These approvals let matching tools run without asking again. Revoking them makes future calls ask again.</p>
					{!data.grants.length && <p>No remembered approvals.</p>}
					{data.grants.map((g) => (
						<article className="management-card" key={g.id}>
							<h3>{g.tool}</h3>
							<p>{g.scope || 'Every call of this tool'}</p>
							<small>{g.conversationId ? 'Only the conversation below' : 'Every conversation'}</small>
							<div>
								{conversation(g.conversationId)}
								<Button variant="outline" disabled={busy} onClick={() => void perform(() => remove(`/grants/${g.id}/delete`))}>
									Revoke approval
								</Button>
							</div>
						</article>
					))}
				</>
			)}
			{data?.schedules && (
				<>
					<p>Ask Mob to schedule something in a conversation; creating a schedule requires approval.</p>
					{!data.schedules.length && <p>Nothing is scheduled.</p>}
					{data.schedules.map((s) => (
						<article className="management-card" key={s.id}>
							<p>{s.prompt}</p>
							<p>
								Next (your local time): {new Date(s.next).toLocaleString()} · {s.repeat || 'Once'}
								{s.zone && ` · ${s.zone}`}
							</p>
							<div>
								{conversation(s.conversationId)}
								<Button
									variant="outline"
									disabled={busy}
									onClick={() =>
										setConfirmation({ text: `Cancel this schedule? “${s.prompt}”`, run: () => command(`/unschedule ${s.id}`) })
									}
								>
									Cancel schedule
								</Button>
							</div>
						</article>
					))}
				</>
			)}
			{data?.projects && (
				<>
					<ProjectForm
						key={data.projects.projects.length}
						busy={busy}
						save={(value) => perform(() => api(connection, paths.projects, { action: 'add', ...value }))}
					/>
					{!data.projects.projects.length && <p>No projects yet.</p>}
					{data.projects.projects.map((p) => (
						<ProjectForm
							key={p.name + JSON.stringify(p)}
							project={p}
							blueprints={data.projects!.blueprints}
							busy={busy}
							save={(value) => perform(() => api(connection, paths.projects, { action: 'save', ...value }))}
							remove={() =>
								setConfirmation({
									text: `Remove project ${p.name}? Its tasks, branches and worktrees stay.`,
									run: () => api(connection, paths.projects, { action: 'remove', name: p.name }),
								})
							}
						/>
					))}
				</>
			)}
			<Dialog
				open={!!confirmation}
				onOpenChange={(on) => {
					if (!on && !busy) setConfirmation(undefined);
				}}
			>
				<DialogContent>
					<DialogTitle>Confirm change</DialogTitle>
					<DialogDescription>{confirmation?.text}</DialogDescription>
					{error && <p role="alert">{error}</p>}
					<div className="management-actions">
						<Button disabled={busy} onClick={() => confirmation && void perform(confirmation.run)}>
							Confirm
						</Button>
						<Button variant="ghost" disabled={busy} onClick={() => setConfirmation(undefined)}>
							Keep unchanged
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

function ProjectForm({
	project,
	blueprints = [],
	busy,
	save,
	remove,
}: {
	project?: ProjectConfig;
	blueprints?: Projects['blueprints'];
	busy: boolean;
	save: (value: ProjectConfig) => Promise<void>;
	remove?: () => void;
}) {
	const [name, setName] = useState(project?.name ?? '');
	const [path, setPath] = useState(project?.path ?? '');
	const [blueprint, setBlueprint] = useState(project?.blueprint || 'standard');
	const [checks, setChecks] = useState(project?.checks ?? []);
	return (
		<form
			className="management-card"
			onSubmit={(e) => {
				e.preventDefault();
				void save(project ? { name, path, blueprint, checks } : { name, path });
			}}
		>
			<h3>{project ? name : 'Add project'}</h3>
			{project ? (
				<code>{path}</code>
			) : (
				<>
					<label>
						Repository path on this Mob
						<input className="ui-input" required value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/project" />
					</label>
					<label>
						Name (optional)
						<input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} />
					</label>
				</>
			)}
			{project && (
				<>
					<label>
						Blueprint
						<select className="ui-input" value={blueprint} onChange={(e) => setBlueprint(e.target.value)}>
							{blueprints.map((b) => (
								<option key={b.name} value={b.name}>
									{b.title}
								</option>
							))}
						</select>
					</label>
					<p>{blueprints.find((b) => b.name === blueprint)?.description}</p>
					<p>
						Checks run automatically, in order, in finished tasks’ worktrees. Only add commands you trust to run without another approval.
					</p>
					{checks.map((check, i) => (
						<div className="management-check" key={i}>
							<label>
								Check {i + 1}
								<textarea
									className="ui-input"
									required
									value={check}
									onChange={(e) => setChecks((list) => list.map((c, n) => (n === i ? e.target.value : c)))}
								/>
							</label>
							<Button type="button" variant="ghost" disabled={busy} onClick={() => setChecks((list) => list.filter((_, n) => n !== i))}>
								Remove check {i + 1}
							</Button>
						</div>
					))}
					<Button type="button" variant="outline" disabled={busy} onClick={() => setChecks((list) => [...list, ''])}>
						Add check
					</Button>
				</>
			)}
			<div className="management-actions">
				<Button disabled={busy}>{project ? 'Save project' : 'Add project'}</Button>
				{remove && (
					<Button type="button" variant="ghost" disabled={busy} onClick={remove}>
						Remove project
					</Button>
				)}
			</div>
		</form>
	);
}
