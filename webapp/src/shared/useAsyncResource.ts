import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsyncResource<T>(load: () => Promise<T>, errorMessage: string) {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const request = useRef(0);

	const reload = useCallback(async () => {
		const id = ++request.current;
		setLoading(true);
		setError('');
		try {
			const value = await load();
			if (id === request.current) setData(value);
		} catch {
			if (id === request.current) setError(errorMessage);
		} finally {
			if (id === request.current) setLoading(false);
		}
	}, [errorMessage, load]);

	useEffect(() => {
		void reload();
		return () => { request.current++; };
	}, [reload]);
	return { data, reload, setData, loading, error };
}
