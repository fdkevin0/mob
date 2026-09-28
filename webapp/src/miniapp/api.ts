import type { AssetList, AssetDetail } from '../../../src/features/assets/types';
import type {
	BootstrapResponse,
	ChatSettingsDataResponse,
	EmailPreviewData,
	EmailSummary,
	GlobalServiceDataResponse,
	MemoryFactPayload,
	ReasoningEffort,
	ScheduledTurnPayload,
} from '../../../src/features/miniapp/contract';
import { requestJson } from '../shared/http';
import { initDataString } from './telegram';

export type { ReasoningEffort };

export const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
	{ value: 'default', label: 'Default (model-chosen)' },
	{ value: 'off', label: 'Off' },
	{ value: 'low', label: 'Low' },
	{ value: 'high', label: 'High' },
	{ value: 'max', label: 'Max' },
];

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
	return requestJson<T>(`/miniapp/settings${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ initData: initDataString(), ...payload }),
	});
}

export const api = {
	listBookmarks: (params: { query?: string; kind?: string; before?: number; beforeId?: string } = {}) => postJson<AssetList>('/bookmarks/list', params),
	getBookmark: (id: string) => postJson<{ asset: AssetDetail }>('/bookmarks/detail', { id }),
	deleteBookmark: (id: string) => postJson<{ ok: true }>('/bookmarks/delete', { id }),
	retryBookmark: (id: string) => postJson<{ ok: true }>('/bookmarks/retry', { id }),
	bookmarkFile: async (id: string, index: number): Promise<Blob> => {
		const response = await fetch('/miniapp/settings/bookmarks/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: initDataString(), id, index }) });
		if (!response.ok) throw new Error('Could not load attachment');
		return response.blob();
	},
	bootstrap: () => postJson<BootstrapResponse>('/data', {}),
	setLanguage: (value: string) => postJson<{ ok: true; stored: string | null; message: string }>('/language/set', { value }),
	setDebug: (enabled: boolean) => postJson<{ ok: true; enabled: boolean }>('/debug/set', { enabled }),
	cancelSchedule: (id: string) => postJson<{ ok: true; cancelled: boolean; schedules: ScheduledTurnPayload[] }>('/schedules/cancel', { id }),
	listEmails: () => postJson<{ emails: EmailSummary[] }>('/email/list', {}),
	getEmail: (id: number) => postJson<{ email: EmailPreviewData }>('/email/data', { id }),
	syncCommands: () => postJson<{ ok: true }>('/commands/sync', {}),
	listMemories: () => postJson<{ memories: MemoryFactPayload[] }>('/memory/list', {}),
	forgetMemories: () => postJson<{ ok: true; count: number }>('/memory/forget', {}),
	globalServiceData: () => postJson<GlobalServiceDataResponse>('/global-service/data', {}),
	setEmailHtmlParser: (parser: 'turndown' | 'ai') =>
		postJson<{ ok: true; emailHtmlParser: 'turndown' | 'ai' }>('/global-service/html-parser/set', { parser }),
	chatSettingsData: () => postJson<ChatSettingsDataResponse>('/chat-settings/data', {}),
	setChatReasoning: (effort: ReasoningEffort) =>
		postJson<{ ok: true; reasoningEffort: ReasoningEffort }>('/chat-settings/reasoning/set', { effort }),
	setChatCompaction: (tokens: number | null) =>
		postJson<{ ok: true; compactionThreshold: number }>('/chat-settings/compaction/set', { tokens }),
	setChatMemoryTopK: (topK: number | null) =>
		postJson<{ ok: true; memoryTopK: number }>('/chat-settings/memory-top-k/set', { topK }),
};
