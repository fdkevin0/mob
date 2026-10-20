/** A cloud host the Connect a runner dialog can deploy a runner to, in the user's own account. */
export type Host = {
	id: string;
	name: string;
	/** deployURL opens the host's one-click deployment; a host without one is not ready yet. */
	deployURL?: string;
	/** summary says what the free tier gives the runner and what it costs to keep conversations. */
	summary: string;
};

const guide = 'https://github.com/fdkevin0/mob/blob/main/docs/features/remote-access.md';
export const hostGuideURL = `${guide}#runners-in-the-cloud`;

// Every host builds the repository's Dockerfile and reads the pairing JSON from MOB_RUNNER_PAIRING.
export const hosts: Host[] = [
	{
		id: 'render',
		name: 'Render',
		// The Render Blueprint is render.yaml at the root of this repository.
		deployURL: 'https://render.com/deploy?repo=https://github.com/fdkevin0/mob',
		summary:
			'Free web service, no card. It has no disk, so conversations and added providers reset whenever Render restarts it; a paid instance with a disk keeps them (about $7.25 a month).',
	},
	{
		id: 'railway',
		name: 'Railway',
		summary: 'Free plan with $1 of usage a month and a 0.5 GB volume, so conversations survive restarts; Railway bills usage beyond the credit.',
	},
	{
		id: 'northflank',
		name: 'Northflank',
		summary: 'Free Sandbox with two always-on services; Northflank verifies a card at sign-up.',
	},
];
