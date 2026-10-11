// The asset integration is private. Public tool tests only cover its disabled state.
export function assetTools(_env: unknown, reader?: unknown) {
	if (reader !== undefined) throw new Error('Asset integration tests require the unpublished assets module');
	return {};
}
