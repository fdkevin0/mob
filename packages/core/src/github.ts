// What the Mob GitHub App's webhooks become on their way to a runner. The
// Worker (apps/web/worker/github.ts) keeps only routing metadata; the runner's
// GitHub plugin (apps/mob/src/github) reads titles, bodies and comments from
// GitHub itself. Both check events with this one module.

/** GitHubEvent is what a runner hears of a webhook: routing metadata, never content. */
export type GitHubEvent = {
	delivery: string;
	event: string;
	action: string;
	installation: number;
	/** repo is owner/name. */
	repo: string;
	/** number is the issue's or pull request's. */
	number?: number;
	pull?: boolean;
	sender: { login: string; id: number; bot: boolean };
	/** association is GitHub's author_association of the comment, issue or pull request the event is about. */
	association?: string;
	label?: string;
	comment?: number;
	/** mention says the comment, review or new issue names the app, as @slug. */
	mention?: boolean;
	/** conclusion is a finished check suite's, with the pull requests it ran for. */
	conclusion?: string;
	pulls?: number[];
	at: number;
};

/** repoName matches owner/name as GitHub allows them: logins of letters, digits and dashes; names without . or .. alone. */
export const repoName = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/((?!\.\.?$)[\w.-]{1,100})$/;

/** deliveryID matches GitHub's X-GitHub-Delivery. */
export const deliveryID = /^[\w-]{1,64}$/;

/** validEvent checks an event a runner received has the shape the Worker sends. */
export function validEvent(v: unknown): v is GitHubEvent {
	if (!v || typeof v !== 'object') return false;
	const e = v as GitHubEvent;
	return typeof e.delivery === 'string' && deliveryID.test(e.delivery) && typeof e.event === 'string' && typeof e.action === 'string' &&
		Number.isSafeInteger(e.installation) && typeof e.repo === 'string' && repoName.test(e.repo) &&
		(e.number === undefined || (Number.isSafeInteger(e.number) && e.number > 0)) &&
		!!e.sender && typeof e.sender.login === 'string' && Number.isSafeInteger(e.sender.id) && typeof e.sender.bot === 'boolean' &&
		(e.label === undefined || typeof e.label === 'string') && Number.isSafeInteger(e.at);
}
