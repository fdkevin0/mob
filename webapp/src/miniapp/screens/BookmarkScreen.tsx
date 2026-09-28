import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AssetSummary } from '../../../../src/features/assets/types';
import { api } from '../api';
import { Button } from '../ui';
import { ResourceState } from '../ResourceState';
import { useAsyncResource } from '../../shared/useAsyncResource';
import { notify } from '../mobile-ui';

function status(row: AssetSummary): string {
	if (row.status === 'pending') return 'Saving originals';
	if (row.status === 'failed') return 'Save failed. Retry available.';
	return { pending: 'Waiting for content processing', processing: 'Indexing', ready: 'Searchable', partial: 'Partially searchable', failed: 'Indexing failed. Originals saved.', unconfigured: 'Saved. AI Search is not configured.' }[row.indexStatus];
}

export function AssetListScreen({ onSelect }: { onSelect: (id: string) => void }): ReactElement {
	const [input, setInput] = useState('');
	const [query, setQuery] = useState('');
	const [kind, setKind] = useState('');
	const [pages, setPages] = useState<Array<{ before: number; beforeId: string }>>([]);
	const cursor = pages.at(-1);
	const load = useCallback(() => api.listBookmarks({ query, kind, ...cursor }), [query, kind, cursor]);
	const { data, loading, error, reload } = useAsyncResource(load, 'Could not load bookmarks. Please retry and ensure the service is configured.');
	return <div className="p-4">
		<header className="mb-4 flex items-center justify-between gap-3"><h1 className="text-xl font-semibold">Bookmarks</h1><Button variant="plain" loading={loading} onClick={reload}>Refresh</Button></header>
		<form className="mb-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); setPages([]); setQuery(input.trim()); }}>
			<input type="search" aria-label="Search bookmarks" placeholder="Search saved content" maxLength={500} value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-separator bg-surface px-3 py-2" />
			<Button type="submit">Search</Button>
		</form>
		<label className="mb-4 flex items-center gap-3 text-sm">Content type
			<select value={kind} onChange={(e) => { setKind(e.target.value); setPages([]); }} className="min-h-11 rounded-xl border border-separator bg-surface px-3">
				<option value="">All</option><option value="text">Text</option><option value="url">Links</option><option value="image">Images</option><option value="file">Files and media</option>
			</select>
		</label>
		<ResourceState loading={loading} error={error} retry={reload} />
		{!loading && data && <>
			{data.warning && <p role="status" className="mb-3 text-sm text-muted">{data.warning}</p>}
			{!data.assets.length && <p className="py-8 text-center text-muted">{query ? 'No matching bookmarks.' : 'No bookmarks yet. Reply to a Telegram message with /bookmark or tap "❤️ Save".'}</p>}
			<ul className="divide-y divide-separator rounded-xl bg-surface">
				{data.assets.map((row) => <li key={row.id}><button type="button" onClick={() => onSelect(row.id)} className="w-full px-4 py-4 text-left active:opacity-75">
					<p className="font-medium wrap-anywhere">{row.title}</p>
					<p className="mt-1 line-clamp-3 text-sm text-muted wrap-anywhere">{row.snippet || row.note}</p>
					<p className="mt-2 text-xs text-muted">{new Date(row.created).toLocaleDateString()} · {status(row)}</p>
				</button></li>)}
			</ul>
			{query && data.assets.length === 20 && <p className="mt-3 text-sm text-muted">Showing the 20 most relevant results. Refine your search to find more.</p>}
			<div className="mt-4 flex justify-between gap-3">
				{!!pages.length && <Button onClick={() => setPages((value) => value.slice(0, -1))}>Previous</Button>}
				{data.next && <Button onClick={() => { const next = data.next; if (next) setPages((value) => [...value, next]); }}>Next</Button>}
			</div>
		</>}
	</div>;
}

function Attachment({ id, file }: { id: string; file: { index: number; name: string; mime: string; available: boolean } }): ReactElement {
	const [url, setUrl] = useState('');
	const image = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mime);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
	const load = async () => {
		try {
			const blob = await api.bookmarkFile(id, file.index);
			if (mounted.current) setUrl(URL.createObjectURL(blob));
		} catch { notify('Could not load the attachment. Please retry.'); }
	};
	return <section className="my-3 rounded-xl border border-separator p-3">
		<p className="mb-2 text-sm wrap-anywhere">{file.name}</p>
		{url ? <>
			{image && <img src={url} alt={file.name} className="mb-3 max-h-96 w-full rounded-lg object-contain" />}
			<a href={url} download={file.name} className="inline-block min-h-11 py-2 text-primary">Download original</a>
		</> : <Button disabled={!file.available} onClick={load}>{image ? 'View image' : 'Load attachment'}</Button>}
	</section>;
}

export function AssetDetailScreen({ id, onDeleted }: { id: string; onDeleted: () => void }): ReactElement {
	const load = useCallback(() => api.getBookmark(id), [id]);
	const { data, loading, error, reload } = useAsyncResource(load, 'Could not load the bookmark. It may have been deleted.');
	const dialog = useRef<HTMLDialogElement>(null);
	const row = data?.asset;
	const remove = async () => {
		try { await api.deleteBookmark(id); dialog.current?.close(); notify('Bookmark deleted'); onDeleted(); }
		catch { notify('Could not delete the bookmark. Please retry.'); }
	};
	const retry = async () => {
		try { await api.retryBookmark(id); notify('Retry submitted'); await reload(); }
		catch { notify('Cannot retry right now. Please refresh later.'); }
	};
	return <div className="p-4">
		<header className="mb-4 flex items-start justify-between gap-3"><h1 className="text-xl font-semibold wrap-anywhere">{row?.title ?? 'Bookmarks'}</h1><Button variant="plain" loading={loading} onClick={reload}>Refresh</Button></header>
		<ResourceState loading={loading && !data} error={error} retry={reload} />
		{row && <>
			<p className="mb-3 text-sm text-muted" role="status">{status(row)}</p>
			{row.note && <p className="mb-4 rounded-xl bg-surface p-3 whitespace-pre-wrap wrap-anywhere">{row.note}</p>}
			<div className="select-text text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{row.text}</div>
			{row.urls.filter((url) => /^https?:\/\//i.test(url)).map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="mt-3 block min-h-11 py-2 text-primary wrap-anywhere">{url}</a>)}
			{row.files.map((file) => <Attachment key={file.index} id={id} file={file} />)}
			<div className="mt-5 flex gap-3">
				{(row.status === 'failed' || ['failed', 'partial', 'unconfigured'].includes(row.indexStatus)) && <Button onClick={retry}>Retry processing</Button>}
				<Button variant="danger" onClick={() => dialog.current?.showModal()}>Delete bookmark</Button>
			</div>
		</>}
		<dialog ref={dialog} aria-labelledby="delete-bookmark-title" className="fixed inset-4 m-auto w-auto max-w-sm rounded-2xl border border-separator bg-surface p-6 text-foreground shadow-xl backdrop:bg-black/40">
			<h2 id="delete-bookmark-title" className="text-lg font-semibold">Delete this bookmark?</h2>
			<p className="mt-2 text-sm text-muted">You will no longer be able to search or read it.</p>
			<div className="mt-6 flex justify-end gap-3"><Button autoFocus onClick={() => dialog.current?.close()}>Cancel</Button><Button variant="danger" onClick={remove}>Delete</Button></div>
		</dialog>
	</div>;
}
