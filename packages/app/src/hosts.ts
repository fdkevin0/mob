import type { ComponentType } from 'react';
import { RenderLogo } from './icons';

/** A cloud host the Connect a runner dialog can deploy a runner to, in the user's own account. */
export type Host = {
	id: string;
	name: string;
	/** Logo is the host's mark, shown on its deploy button. */
	Logo: ComponentType;
	/** deployURL opens the host's one-click deployment; a host without one is not ready yet. */
	deployURL?: string;
	/** summary says what the free tier gives the runner and what it costs to keep conversations. */
	summary: string;
};

export const hostGuideURL = 'https://github.com/fdkevin0/mob/blob/main/docs/features/cloud-runners.md';

// Every host builds the repository's Dockerfile and reads the pairing JSON from MOB_RUNNER_PAIRING.
// Railway and Northflank are candidates; docs/features/cloud-runners.md says what adding them takes.
export const hosts: Host[] = [
	{
		id: 'render',
		name: 'Render',
		Logo: RenderLogo,
		// The Render Blueprint is render.yaml at the root of this repository.
		deployURL: 'https://render.com/deploy?repo=https://github.com/fdkevin0/mob',
		summary:
			'Free web service, no card. It has no disk, so conversations and added providers reset whenever Render restarts it; a paid instance with a disk keeps them (about $7.25 a month).',
	},
];
