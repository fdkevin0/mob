import { useCallback } from 'react';
import { List } from '../ui';
import { useAsyncResource } from '../../shared/useAsyncResource';
import { ResourceState } from '../ResourceState';
import { api } from '../api';
import { formatFileSize } from '../../../../src/utils/tool';

interface Props {
	id: number;
}

export function EmailDetailScreen({ id }: Props) {
	const load = useCallback(() => api.getEmail(id), [id]);
	const { data, loading, error, reload } = useAsyncResource(load, 'Could not load email');
	const email = data?.email;
	if (!email) return <div className="p-4"><ResourceState loading={loading} error={error} retry={reload} /></div>;

	return (
		<div className="p-4">
			<header className="mb-4 border-b border-separator pb-4" id="email-detail-header">
				<div>
					<h1 className="mb-4 text-xl leading-tight font-semibold wrap-anywhere">
						{email.spam && <span className="mr-2 text-danger">SPAM</span>}
						{email.subject || '(no subject)'}
					</h1>
				</div>
				<div className="flex flex-wrap gap-x-2 gap-y-1 text-sm wrap-anywhere text-muted">
					<span>{email.from}</span>
					{email.date && <span>{email.date}</span>}
				</div>
				{email.auth && (
					<p className="text-sm wrap-anywhere" id="email-detail-auth">
						SPF {email.auth.spf ?? 'none'} · DKIM {email.auth.dkim ?? 'none'} · DMARC {email.auth.dmarc ?? 'none'}
					</p>
				)}
			</header>
			<div  id="email-detail-body">
				{email.html ? (
					<iframe className="block min-h-96 w-full border-0 bg-white scheme-light" title="Email body" sandbox="" srcDoc={email.html} scrolling="yes" />
				) : email.text ? (
					<pre className="select-text whitespace-pre-wrap wrap-anywhere">{email.text}</pre>
				) : (
					<p className="text-muted">This email has no viewable body.</p>
				)}
			</div>
			{email.attachments.length > 0 && (
				<List header="Attachments" >
					{email.attachments.map((a) => (
						<List.Item key={a.filename}>
							{a.filename} ({formatFileSize(a.size)})
						</List.Item>
					))}
				</List>
			)}
		</div>
	);
}
