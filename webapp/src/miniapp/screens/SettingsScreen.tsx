import { notify } from '../mobile-ui';
import { useState } from 'react';
import { Button, List } from '../ui';
import type { Capability, ScheduledTurnPayload } from '../../../../src/features/miniapp/contract';
import { api } from '../api';

interface Props {
	capabilities: Capability[];
	language: string | null;
	debug?: boolean;
	schedules?: ScheduledTurnPayload[];
	onOpenChatSettings: () => void;
	onOpenGlobalService: () => void;
	onLanguageChange: (value: string | null) => void;
	onDebugChange: (enabled: boolean) => void;
	onSchedulesChange: (schedules: ScheduledTurnPayload[]) => void;
}

export function SettingsScreen({ capabilities, language, debug, schedules, onOpenChatSettings, onOpenGlobalService, onLanguageChange, onDebugChange, onSchedulesChange }: Props) {
	const [languageInput, setLanguageInput] = useState(language ?? '');
	const [savingLanguage, setSavingLanguage] = useState(false);
	const [savingDebug, setSavingDebug] = useState(false);

	const saveLanguage = async () => {
		if (savingLanguage) return;
		setSavingLanguage(true);
		try {
			const data = await api.setLanguage(languageInput);
			setLanguageInput(data.stored ?? '');
			onLanguageChange(data.stored);
			notify('Language saved');
		} catch {
			notify('Could not save language');
		} finally {
			setSavingLanguage(false);
		}
	};

	const toggleDebug = async (enabled: boolean) => {
		if (savingDebug) return;
		setSavingDebug(true);
		try {
			const data = await api.setDebug(enabled);
			onDebugChange(data.enabled);
			notify(data.enabled ? 'Debug enabled' : 'Debug disabled');
		} catch {
			notify('Could not save debug setting');
		} finally {
			setSavingDebug(false);
		}
	};

	const cancelSchedule = async (id: string) => {
		try {
			const data = await api.cancelSchedule(id);
			onSchedulesChange(data.schedules);
			notify(data.cancelled ? 'Schedule cancelled' : 'Schedule already removed');
		} catch {
			notify('Could not cancel schedule');
		}
	};

	const syncCommands = async () => {
		try {
			await api.syncCommands();
			notify('Commands synced');
		} catch {
			notify('Could not sync commands');
		}
	};

	return (
		<div className="p-4">
			<h1 className="mb-4 text-xl leading-tight font-semibold wrap-anywhere">Settings</h1>
			<List>
				<List.Item><Button className="w-full text-left" variant="plain" onClick={onOpenChatSettings}>Chat settings</Button></List.Item>
				{capabilities.includes('admin_ops') && <List.Item><Button className="w-full text-left" variant="plain" onClick={onOpenGlobalService}>Email processing</Button></List.Item>}
			</List>
			<form onSubmit={(event) => { event.preventDefault(); void saveLanguage(); }}>
				<List header={<label htmlFor="language">Reply language</label>}>
					<List.Item description="Leave blank to follow the chat.">
						<input className="min-h-11 w-full bg-surface text-base disabled:opacity-50" id="language" aria-label="Reply language" enterKeyHint="done" disabled={savingLanguage}
							value={languageInput} placeholder="e.g. English" onChange={(event) => setLanguageInput(event.target.value)} />
					</List.Item>
				</List>
				<div className="mt-3 mb-5"><Button className="w-full" variant="primary" type="submit" loading={savingLanguage} loadingText="Saving">Save language</Button></div>
			</form>
			{capabilities.includes('view_debug') && (
				<List header="Diagnostics">
					<List.Item description="Include diagnostic traces in replies.">
						<label className="flex min-h-11 cursor-pointer items-center gap-3 select-none"><input type="checkbox" className="size-5 accent-primary" checked={debug ?? false} disabled={savingDebug} onChange={(event) => void toggleDebug(event.target.checked)} />Debug mode</label>
					</List.Item>
				</List>
			)}
			{capabilities.includes('schedule_turns') && (
				<List header="Schedules">
					{!schedules?.length && <List.Item>No upcoming schedules</List.Item>}
					{schedules?.map((task) => (
						<List.Item key={task.id} description={<>
							{task.next ? new Date(task.next).toLocaleString() : 'No next run'}
							{task.lastError && <p className="text-danger">{task.lastError}</p>}
						</>} extra={<Button variant="danger" onClick={() => cancelSchedule(task.id)}>Cancel</Button>}>
							{task.description}
						</List.Item>
					))}
				</List>
			)}
			{capabilities.includes('admin_ops') && <div className="mt-3 mb-5"><Button className="w-full" onClick={syncCommands}>Sync commands</Button></div>}
			<footer className="mt-6 text-center text-xs text-muted">
				<p>Version {import.meta.env.VITE_APP_VERSION}</p>
				<p>Built {import.meta.env.VITE_BUILD_DATE}</p>
			</footer>
		</div>
	);
}
