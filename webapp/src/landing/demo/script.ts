// The landing page's demo replays a few recorded tasks. Each one is a prompt,
// the steps Mob takes, one approval, and the answer for either decision. The
// player below is a pure state machine so the page, the autopilot and the
// tests all drive it the same way.

export type Channel = 'web' | 'chat';
export type Decision = 'allow' | 'always' | 'deny';

export type Step =
	| { kind: 'think'; text: string; ms: number }
	| { kind: 'tool'; title: string; detail: string; result: string; ms: number }
	| { kind: 'approve'; title: string; detail: string; question: string; preview?: string; result: string; chat: string; ms: number };

export type Scenario = {
	title: string;
	channel: Channel;
	prompt: string;
	steps: Step[];
	/** The answer in the web app, in a little Markdown: **bold**, `code`, - lists and | tables |. */
	answer: string;
	denied: string;
	/** Messaging channels get only the conclusion. */
	brief: string;
	briefDenied: string;
};

export const scenarios: Scenario[] = [
	{
		title: 'September invoices',
		channel: 'web',
		prompt: "Find last month's invoices in my email and put the totals in a sheet.",
		steps: [
			{ kind: 'think', text: 'Search the mailbox for September invoices, read the PDF totals, then write a CSV the user can open in any spreadsheet.', ms: 1300 },
			{ kind: 'tool', title: 'Search email', detail: 'invoice after:2026/09/01 before:2026/10/01', result: '4 messages\nHetzner Online · Sep 3\nFigma · Sep 12\nNotion Labs · Sep 18\nFastmail · Sep 28', ms: 1500 },
			{ kind: 'tool', title: 'Read attachments', detail: '4 PDFs', result: 'hetzner-R0021.pdf   €412.80\nfigma-6631.pdf      €540.00\nnotion-INV-0918.pdf €288.00\nfastmail-2209.pdf   €43.70', ms: 1700 },
			{ kind: 'approve', title: 'Write file', detail: '~/Documents/invoices-september.csv', question: 'Mob wants to write a file.', preview: 'vendor,date,total\nHetzner Online,2026-09-03,412.80\nFigma,2026-09-12,540.00\nNotion Labs,2026-09-18,288.00\nFastmail,2026-09-28,43.70', result: 'Wrote 5 lines (162 bytes)', chat: 'Write a file?\n~/Documents/invoices-september.csv', ms: 900 },
		],
		answer: 'Filed **4** September invoices, **€1,284.50** in total.\n| Vendor | Date | Total |\n| Hetzner Online | Sep 3 | €412.80 |\n| Figma | Sep 12 | €540.00 |\n| Notion Labs | Sep 18 | €288.00 |\n| Fastmail | Sep 28 | €43.70 |\nThe sheet is in `~/Documents/invoices-september.csv`.',
		denied: "I didn't write anything. Here are the **€1,284.50** of September invoices to paste wherever you like.\n| Vendor | Date | Total |\n| Hetzner Online | Sep 3 | €412.80 |\n| Figma | Sep 12 | €540.00 |\n| Notion Labs | Sep 18 | €288.00 |\n| Fastmail | Sep 28 | €43.70 |",
		brief: 'Filed 4 September invoices, €1,284.50 in total, in invoices-september.csv.',
		briefDenied: "Didn't write the file. September came to €1,284.50 over 4 invoices.",
	},
	{
		title: 'Failing checkout tests',
		channel: 'chat',
		prompt: 'The checkout tests are failing on main, can you fix them?',
		steps: [
			{ kind: 'think', text: 'Run the tests in the sandbox first to see the failure, then read the code it points at.', ms: 1100 },
			{ kind: 'tool', title: 'Run command', detail: 'go test ./internal/checkout/...', result: '--- FAIL: TestTotal (0.00s)\n    total_test.go:24: got 1284.49, want 1284.50\nFAIL\tmob.dev/shop/internal/checkout\t0.21s', ms: 1800 },
			{ kind: 'tool', title: 'Read file', detail: 'internal/checkout/total.go', result: '17  for _, l := range lines {\n18  \tsum += l.Price * float64(l.Qty)\n19  }\n20  return math.Floor(sum*100) / 100', ms: 1200 },
			{ kind: 'approve', title: 'Edit file', detail: 'internal/checkout/total.go', question: 'Mob wants to edit a file.', preview: '-\tsum += l.Price * float64(l.Qty)\n+\tcents += l.Cents * int64(l.Qty)\n-\treturn math.Floor(sum*100) / 100\n+\treturn Money(cents)', result: '1 file changed, 2 insertions(+), 2 deletions(-)', chat: 'Edit a file?\ninternal/checkout/total.go', ms: 900 },
			{ kind: 'tool', title: 'Run command', detail: 'go test ./...', result: 'ok  \tmob.dev/shop/internal/checkout\t0.19s\nok  \tmob.dev/shop/internal/cart\t0.11s\n42 tests passed', ms: 1900 },
		],
		answer: 'Fixed. The totals were added up as `float64` and rounded down, so €1,284.50 came out as €1,284.49.\n- Line items now add up in whole cents\n- `go test ./...` passes, 42 tests\nThe change is one file in your working tree, ready for you to review and commit.',
		denied: 'Left your files alone. The bug is on line 18 of `internal/checkout/total.go`: totals are added up as `float64` and rounded down, so €1,284.50 comes out as €1,284.49.\n- Add line items up in whole cents instead\nSay the word and I will make the change.',
		brief: 'Fixed: totals now add up in cents instead of rounding a float down. go test ./... passes (42 tests). One file changed, ready to commit.',
		briefDenied: 'Left your files alone. The bug: total.go adds prices as float64 and rounds down. Say the word and I will fix it.',
	},
	{
		title: 'Morning review list',
		channel: 'web',
		prompt: 'Every weekday at 9, send me the pull requests waiting on my review.',
		steps: [
			{ kind: 'think', text: 'There is no GitHub tool loaded yet. Look one up, check it works, then set up the schedule.', ms: 1100 },
			{ kind: 'tool', title: 'Search tools', detail: 'github pull requests review', result: 'github · search_pull_requests  (MCP, signed in)\ngithub · list_notifications    (MCP, signed in)', ms: 1300 },
			{ kind: 'tool', title: 'Search pull requests', detail: 'is:open review-requested:@me', result: '#92  Smoother web UI           mob\n#89  Calf pasture in the TUI   mob\n#61  Exposure levels           mob', ms: 1500 },
			{ kind: 'approve', title: 'Create schedule', detail: 'weekdays 09:00 · chat app', question: 'Mob wants to create a schedule.', preview: 'every: mon-fri 09:00 Europe/London\ndeliver: chat\ntask: list pull requests waiting on my review', result: 'Scheduled, next run Mon 09:00', chat: 'Create a schedule?\nweekdays 09:00', ms: 900 },
		],
		answer: "Done. Every weekday at **09:00** you'll get the list in your chat app. Three are waiting right now:\n- **#92** Smoother web UI\n- **#89** Calf pasture in the TUI\n- **#61** Exposure levels\nSay `/schedules` to see or stop it.",
		denied: 'No schedule then. Three pull requests are waiting on you right now:\n- **#92** Smoother web UI\n- **#89** Calf pasture in the TUI\n- **#61** Exposure levels',
		brief: 'Scheduled for weekdays at 09:00. Waiting now: #92 Smoother web UI, #89 Calf pasture in the TUI, #61 Exposure levels.',
		briefDenied: 'No schedule. Waiting now: #92, #89 and #61.',
	},
];

export type Phase = 'compose' | 'run' | 'wait' | 'answer' | 'done';
export type State = { scenario: number; channel: Channel; phase: Phase; typed: number; step: number; words: number; decision?: Decision };

export const start = (scenario: number, channel = scenarios[scenario].channel): State =>
	({ scenario, channel, phase: 'compose', typed: 0, step: 0, words: 0 });

export const answerOf = (s: State) => {
	const sc = scenarios[s.scenario];
	return s.decision === 'deny' ? sc.denied : sc.answer;
};
export const briefOf = (s: State) => {
	const sc = scenarios[s.scenario];
	return s.decision === 'deny' ? sc.briefDenied : sc.brief;
};
// The answer streams in a few words at a time; the spaces count as tokens.
const tokens = (text: string) => text.split(/(\s+)/);

/** delay is how long the state shows before tick moves it on, or undefined while it waits on someone. */
export function delay(s: State): number | undefined {
	const sc = scenarios[s.scenario];
	switch (s.phase) {
		case 'compose': return s.typed < sc.prompt.length ? 26 : 500;
		case 'run': return sc.steps[s.step].ms;
		case 'answer': return 45;
		default: return undefined;
	}
}

// Moving on to step i: an approval stops and waits.
const enter = (s: State, i: number): State => {
	const steps = scenarios[s.scenario].steps;
	if (i >= steps.length) return { ...s, phase: 'answer', step: i, words: 0 };
	return { ...s, step: i, phase: steps[i].kind === 'approve' ? 'wait' : 'run' };
};

export function tick(s: State): State {
	const sc = scenarios[s.scenario];
	switch (s.phase) {
		case 'compose': return s.typed < sc.prompt.length ? { ...s, typed: Math.min(sc.prompt.length, s.typed + 2) } : enter(s, 0);
		case 'run': return enter(s, s.step + 1);
		case 'answer': {
			const words = s.words + 6;
			return words >= tokens(answerOf(s)).length ? { ...s, phase: 'done', words } : { ...s, words };
		}
		default: return s;
	}
}

export function decide(s: State, decision: Decision): State {
	if (s.phase !== 'wait') return s;
	return decision === 'deny' ? { ...s, decision, phase: 'answer', words: 0 } : { ...s, decision, phase: 'run' };
}

/** finish plays a task straight through, for reduced motion. */
export function finish(scenario: number, decision: Decision = 'allow', channel?: Channel): State {
	let s = start(scenario, channel);
	while (s.phase !== 'done') s = s.phase === 'wait' ? decide(s, decision) : tick(s);
	return s;
}

export const shownAnswer = (s: State) => s.phase === 'done' ? answerOf(s) : tokens(answerOf(s)).slice(0, s.words).join('');

export type StepStatus = 'running' | 'waiting' | 'done' | 'denied';
/** visible lists the steps on screen and how each stands. */
export function visible(s: State): { step: Step; status: StepStatus }[] {
	if (s.phase === 'compose') return [];
	const steps = scenarios[s.scenario].steps;
	const last = s.phase === 'answer' || s.phase === 'done' ? (s.decision === 'deny' ? s.step : steps.length - 1) : s.step;
	return steps.slice(0, last + 1).map((step, i) => ({
		step,
		status: i < s.step || (s.phase !== 'run' && s.phase !== 'wait' && s.decision !== 'deny') ? 'done'
			: s.decision === 'deny' && i === s.step ? 'denied'
			: s.phase === 'wait' ? 'waiting' : 'running',
	}));
}
