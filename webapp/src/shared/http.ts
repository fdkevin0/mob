export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `request failed (${response.status})`);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}
