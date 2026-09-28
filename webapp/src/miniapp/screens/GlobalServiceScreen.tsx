import { notify } from '../mobile-ui';
import { useState } from 'react';
import { List } from '../ui';
import { useAsyncResource } from '../../shared/useAsyncResource';
import { api } from '../api';
import { ResourceState } from '../ResourceState';

export function GlobalServiceScreen() {
	const { data, setData, loading, error, reload } = useAsyncResource(api.globalServiceData, 'Could not load email settings');
	const [saving, setSaving] = useState(false);
	const setHtmlParser = async (parser: 'turndown' | 'ai') => {
		if (saving) return;
		setSaving(true);
		try {
			const res = await api.setEmailHtmlParser(parser);
			setData(res);
			notify('Email processing saved');
		} catch {
			notify('Could not save email processing');
		} finally {
			setSaving(false);
		}
	};
	return (
		<div className="p-4">
			<h1 className="mb-4 text-xl leading-tight font-semibold wrap-anywhere">Email processing</h1>
			<ResourceState loading={loading && !data} error={error} retry={reload} />
			{data && <List header={<label htmlFor="email-html-converter">HTML conversion</label>}>
				<List.Item description="AI processes images, including tracking pixels, and may incur charges.">
					<select className="min-h-11 w-full rounded-none border-0 bg-surface text-base disabled:opacity-50" id="email-html-converter" disabled={saving} value={data.emailHtmlParser}
						onChange={(e) => void setHtmlParser(e.target.value as 'turndown' | 'ai')}>
						<option value="turndown">Standard (free)</option>
						<option value="ai">AI (paid)</option>
					</select>
				</List.Item>
			</List>}
		</div>
	);
}
