export type AssetScope = `user:${number}` | `chat:${number}`;
export interface AssetFile {
	origin: { type: 'telegram'; fileId: string };
	name: string;
	mime: string;
	size?: number;
	key?: string;
}
export interface AssetSource {
	origin: { type: 'telegram'; chatId: number; messageId: number } | { type: 'email'; emailId: number };
	title?: string;
	text: string;
	urls: string[];
	files: AssetFile[];
	kind: string;
}
export interface Asset {
	id: string;
	scope: AssetScope;
	createdBy: number;
	source: AssetSource;
	title: string;
	note: string;
	created: number;
	status: 'pending' | 'saved' | 'failed';
	indexStatus: 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unconfigured';
	text: string;
	itemId: string | null;
	partial: number;
	deleted: number;
	notified: number;
	attempts: number;
	lease: number;
	nextAttempt: number;
}
export interface AssetSummary extends Pick<Asset, 'id' | 'title' | 'note' | 'created' | 'status' | 'indexStatus'> {
	kind: string;
	snippet: string;
}
export function summary(row: Asset, snippet = row.source.text): AssetSummary {
	return { id: row.id, title: row.title, kind: row.source.kind, note: row.note, created: row.created,
		status: row.status, indexStatus: row.indexStatus, snippet: snippet.slice(0, 500) };
}
export interface AssetDetail extends AssetSummary {
	text: string;
	urls: string[];
	files: Array<{ index: number; name: string; mime: string; available: boolean }>;
}
export interface AssetList {
	assets: AssetSummary[];
	mode: 'semantic' | 'local';
	warning?: string;
	next?: { before: number; beforeId: string } | null;
}
