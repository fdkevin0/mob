import { Button } from './ui';

export function ResourceState({ loading, error, retry }: { loading: boolean; error: string; retry: () => Promise<void> }) {
	if (error) return <div className="py-4" role="alert"><p className="mb-3">{error}</p><Button onClick={retry}>Retry</Button></div>;
	if (!loading) return null;
	return <div className="space-y-3 py-3 motion-safe:animate-pulse" role="status" aria-label="Loading">
		<div className="h-5 w-1/3 rounded bg-separator" />
		<div className="h-3 rounded bg-separator" /><div className="h-3 rounded bg-separator" /><div className="h-3 w-2/3 rounded bg-separator" />
	</div>;
}
