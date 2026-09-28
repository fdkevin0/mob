import { Button, List } from '../ui';
import { useAsyncResource } from '../../shared/useAsyncResource';
import { api } from '../api';
import { ResourceState } from '../ResourceState';

export function EmailListScreen({ onSelect }: { onSelect: (id: number) => void }) {
	const { data, reload, loading, error } = useAsyncResource(api.listEmails, 'Could not load emails');
	return <div className="p-4">
		<header className="mb-4 flex items-center justify-between gap-3">
			<h1 className="text-xl leading-tight font-semibold wrap-anywhere">Email</h1>
			<Button variant="plain" loading={loading} aria-label="Refresh emails" onClick={reload}>Refresh</Button>
		</header>
		<ResourceState loading={loading && !data} error={error} retry={reload} />
		{data && !data.emails.length && <p className="text-muted">No emails</p>}
		<List>
			{data?.emails.map((item) => <List.Item key={item.id} description={<>
				<div className="flex flex-wrap gap-x-2 gap-y-1 text-sm wrap-anywhere text-muted">{item.from}{item.date && ` · ${item.date}`}</div>
				{item.snippet && <p className="mt-1.5 line-clamp-2">{item.snippet}</p>}
			</>}>
				<Button className="w-full text-left" variant="plain" onClick={() => onSelect(item.id)}>
					{item.spam && <span className="mr-2 text-danger">SPAM </span>}{item.subject || '(no subject)'}
				</Button>
			</List.Item>)}
		</List>
	</div>;
}
