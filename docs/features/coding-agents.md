# Coding agents

Mob hands coding work to outside coding agents and keeps track of it. Mob's
own model acts as the owner's project manager: it starts a task in a project,
reports how tasks are going and what waits for a decision, and passes on
instructions. The agent writes the code. Agents speak the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP); the code is in
`apps/mob/src/agents`, on the official TypeScript SDK `@agentclientprotocol/sdk`.

## Agents

| Agent | Started with | Signing in |
| --- | --- | --- |
| `codex` (default) | `codex-acp` when installed, otherwise `npx -y @zed-industries/codex-acp@0.16.0` | the ChatGPT subscription `codex login` saved on that computer (`codex login --device-auth` where it has no browser), or `OPENAI_API_KEY` / `CODEX_API_KEY` in the service's environment |
| `claude` (Claude Agent) | `claude-agent-acp` when installed, otherwise `npx -y @agentclientprotocol/claude-agent-acp@0.94.0` | the Claude subscription `claude` saved on that computer (run `claude` and `/login`), or `ANTHROPIC_API_KEY` in the service's environment |
| `dsh` (DeepSeek Harness) | `npx -y @deepseek-ai/dsh@0.2.1-rc.2 --profile acp` (only through `npx`, since other programs are also called `dsh`) | the DeepSeek API key saved in DeepSeek Harness (`npx @deepseek-ai/dsh web`, Models page), or `DEEPSEEK_API_KEY` in the service's environment |
| `codebuddy` (CodeBuddy Code) | `codebuddy --acp` when installed, otherwise `npx -y @tencent-ai/codebuddy-code@2.171.0 --acp` | the Tencent account `codebuddy` logged in with on that computer (WeChat for the China edition, Google or GitHub for the international one; the same account as WorkBuddy), or `CODEBUDDY_API_KEY` in the service's environment, with `CODEBUDDY_INTERNET_ENVIRONMENT=internal` for the China edition |

The agent runs on the computer Mob runs on, as the same user, with Mob's
environment minus its `MOB_*` variables. Mob keeps no agent credentials: the
agent uses its own sign-in. When it asks to sign in, Mob tries an
environment-variable method whose variable is set, and otherwise fails the
turn with how to sign in. Claude Agent only finds out it is not signed in
when it answers a prompt; that turn fails the same way. DeepSeek Harness asks
for no sign-in; without a key, its first prompt fails and says where to save
one. Mob never reads or passes on a DeepSeek key, including the one in its own
DeepSeek provider. Amp is planned next.

Mob starts DeepSeek Harness with its DeepSeek session-log upload plugin
disabled (a `--patch` layer in a temporary file only the service's user can
read, removed when the agent ends) and `DSH_TELEMETRY_MODE=DISABLED`, so what
the agent does is not sent to DeepSeek beyond the model requests themselves.
Its model is the ACP profile's default, `deepseek-v4-flash`.

Tencent's WorkBuddy desktop app offers no programmatic interface; CodeBuddy
Code, the command-line agent built on the same agent core, is how Mob reaches
it. Its login methods are interactive, so without a login (or
`CODEBUDDY_API_KEY`) starting a session fails with how to log in.

## Projects and tasks

- A project is a git repository on that computer, saved in the `projects`
  setting. `/projects add PATH [NAME]` saves one (named after its directory by
  default), `/projects remove NAME` forgets it, and `/projects` lists them
  with their blueprint and checks (see Blueprints below).
  `task_start` also accepts the absolute path of a repository and saves it.
- A task is one piece of work for one agent. It gets its own branch,
  `mob/<title>-<id>`, checked out from the project's `HEAD` in a new worktree
  under `data_dir/worktrees/`, so tasks never touch the project's own checkout
  or each other. Stopping or finishing a task leaves its branch and worktree;
  merging and cleaning up are the owner's.
- Each task is a conversation, titled `<agent>: <title>`, listed with the
  others. The agent's replies stream into it like a model's: text, reasoning,
  and one line per tool call (`codex_execute`, `claude_edit`, `codex_read` and
  so on, after the agent and the call's ACP kind) that opens to show its input and output.
  The owner can write to it directly; only the owner can.
- Tasks are saved in the `tasks` table with their status: `running`,
  `waiting` (for the owner's approval), `review` (the agent finished what it
  was asked), `stopped` or `failed`, the agent's latest plan, and the
  conversation that started the task (`parent_id`; empty when none did).

## Mob as project manager

Owner-only tools:

- `task_start` (project, prompt, optional title, agent and blueprint) asks
  the owner to approve, showing the blueprint and what it does, then creates
  the worktree and task and hands the prompt to the agent in a turn that runs
  on its own. Always allow covers the same project, agent and blueprint. Its prompt tells the model to hand coding work to agents rather
  than do it itself. With `share` (a task's ID) the agent instead works
  read-only in that task's worktree and branch (see Readers below); Always
  allow then covers only that task.
- `tasks` lists the projects and tasks with status, branch, plan, the end of
  each task's latest reply, the outcome and result its agent reported (see
  Results below) and what its agent used (see Usage below).
- `task_message` passes instructions to a task's agent. While the agent is
  at work they are added to its conversation and sent once its current
  prompt ends. `task_stop` stops its turn and ends the agent.
- `task_diff` shows what a task changed since its branch began: its commits
  (up to 30), each changed file with lines added and removed (committed and
  not), untracked files, and on request the patch, whole or for one file, up
  to 24000 bytes. The patch includes new files the agent has not added to
  git, in full. The branch began where it meets the project's `HEAD`, so
  the project moving on does not show up as the task's change. It reads
  without approval.
- `task_check` runs a shell command, such as the tests or the build, in a
  task's worktree on the computer Mob runs on (`sh -c`, `cmd /C` on Windows),
  with Mob's environment minus its `MOB_*` variables, and returns the exit
  code and the last 32 KiB of its output. Every command asks for approval;
  Always allow covers the same command in the same project. A command still
  running after ten minutes is ended.
- `task_review` asks the owner to approve a review squad for a finished task
  (see Review squads below).

`task_start` is offered while an agent's command (or `npx`) is installed, or
once there is a project or task; the others once there is a project or task.
`/tasks [PROJECT]` shows the tasks in any client as a list nested by who
started whom, with each task's status, agent, title, project and branch.

## Agent tree

`GET /api/tasks[?project=NAME]` lists the tasks, each with the conversation
that started it, its agent's display name, the model it runs, what it used
(the conversation's [usage](#usage) summary), the decisions waiting in it, the kinds of tool its agent used (`read`, `edit`, `execute`,
`fetch` and so on) and the task itself. A Mob conversation that started tasks
is listed too, as agent `mob`: `waiting` while a decision waits in it (such
as `task_start` itself), `running` while it answers, otherwise `idle`. The
model is the one a running agent's session options select, otherwise the
model that used the most of the conversation's tokens; `/tasks` adds what
each one used.

The web UI's **Agents** page draws this as a tree: Mob's conversation on top,
the tasks it started fanned out in a row below it, and anything those tasks
started hanging under them. Lines with arrows run from each agent to the ones
it started, coloured by the started agent's status, with work flowing along
the line while it runs or waits. Each card shows the runtime's logo (Codex,
Claude Agent; Mob's calf for Mob), the model's logo and name, status (Running,
Needs you, Done, Failed, Stopped), the tools it used, the task's title,
project and branch, its cost and tokens (broken down by cache and model on
hover), its plan's progress and how long it took. Clicking a card
that started agents folds them away (it then shows how many are hidden) and
clicking again unfolds them; its arrow button opens its conversation.

A card that needs the owner shows up to two of its waiting decisions, each
with everything it asks (one `field: value` line per input field, so an
agent's command shows rather than only its title), and **Approve**, **Always
allow** and **Deny…** (which takes an optional reason); more are left to the
conversation. A request with a field too long to show whole (`whole: false`)
can only be denied there and is approved from its conversation. A running or
waiting card has **Stop**, and a task's card has **Instruct**, which sends the
agent one more line while it runs. They use:

- `POST /api/conversations/{id}/decide` with `{id, approved, reason?,
  remember?}`: answers a waiting decision as the owner and resumes the turn
  (202; 409 when the decision is no longer waiting).
- `POST /api/tasks/{id}/stop`: stops the task (404 when there is none).
- `POST /api/tasks/{id}/message` with `{text}`: sends the running agent an
  instruction (202; 409 when the agent is still starting). A turn it starts
  ends when the token that sent it is revoked.

Mob's own card stops with `POST /api/conversations/{id}/stop`. The
header counts the agents, filters to what runs, needs the owner or failed,
and adds up what they all cost. The page reads the tree again every three seconds while it is shown.
Logos come from LobeHub's MIT-licensed `@lobehub/icons-static-svg`, inlined
into the page.

The owner's turns also read a snapshot of the tasks in their instructions, so
the model knows what is going on without calling `tasks` first: up to 15
tasks that are running, waiting, or ended (in review or failed) in the last
seven days, each with its status, title, ID, agent, project and branch.
Stopped tasks and other callers' turns get none. The snapshot changes when a
task does, which misses the prompt cache once.

## Blueprints

A blueprint is how a task Mob's model started goes from the agent's finished
work to ready to review. Mob runs it itself, step by step, so the checks, the
review and the rounds of rework do not depend on a model remembering them.
Sub-tasks and readers have none: their parent task's agent checks them.

| Blueprint | After the agent's work |
| --- | --- |
| `standard` (the default) | the project's checks, then a review of correctness and tests by another agent |
| `quick` | the project's checks |
| `manual` | Mob's model checks the work as it sees fit (see Reviewing finished work below) |

`/blueprints` lists them. `/projects blueprint NAME BLUEPRINT` sets a
project's; `task_start` may pick another for one task.

**Checks** are the project's commands, such as its tests or build:
`/projects check NAME COMMAND` adds one, `/projects checks NAME` lists them
and `/projects checks NAME clear` removes them all. Mob runs them in order in
the task's worktree, as `task_check` does, without asking: the owner typed
them. No tool sets them, so a model reading untrusted text cannot plant a
command that runs on its own later. When one fails, the end of its output
goes back to the same agent as an automatic update, and its next finished
turn runs the checks again; after `retries` failures (2 in the built-ins) the
task is stuck. A project with no checks passes this step, and the ready
notice says how to add one.

**Review** starts a review squad (see Review squads below) of another agent
than the one that did the work, where one can work read-only, one reviewer
per aspect. When they all pass, the work is ready. Otherwise Mob's model
checks their findings in the conversation that started the task, and either
sends those that hold back to the agent with `task_message`, whose next
finished turn is the next round (the checks and review run again), or
concludes; on the last round (2 in `standard`) it only concludes. A squad
that cannot start is noted and skipped.

The owner hears once, at the end: **Ready to review** with the branch, git's
count of the change, each check's result, the review's conclusion and what
the task used, or **Task needs you** with why and the end of the failing
output. The notice is also saved as a note in the conversation. Writing to the
task afterwards starts a new round. Stopping a task, or giving it more work
while it is checked or reviewed, drops what was under way, its reviewers
included: their reports would be about work that changed.

Where a task is in its blueprint is saved in `tasks.flow`: the blueprint,
the stage (`build`, `verify`, `review`, `ready` or `stuck`), the round, the
retries used, the last checks and the review's conclusion. `tasks`, `/tasks`,
the agent tree and the model's view of the tasks show it. A task that was
being checked or reviewed when Mob stopped is stuck when it starts again.

A blueprint's loops are bounded: at most 3 retries and 3 review rounds, each
stage once, verify before review. The built-ins are the only blueprints for
now.

## Reviewing finished work

This is the `manual` blueprint, and what a task started before blueprints
gets. A task remembers the conversation that started it (`tasks.parent_id`,
also used for the agent tree). When a task Mob's model started ends its turn
in review with something written, the model reviews the work in that
conversation before
the owner hears about it: a turn starts there with a note, saved as the
turn's message, saying it is an automatic update and asking the model to
check the work with `task_diff` and `task_check`, then tell the owner whether
it looks ready to merge, what is missing, and what they need to decide. It
may send the agent more work with `task_message` only when the task is
clearly not done.

When that turn ends, the owner gets one notice, "Task reviewed", with the
model's conclusion and any approval it waits for (such as a `task_check`
command), instead of the agent's own words. At most three reviews start on
their own for one task while Mob runs. A task with no parent, one another
task started (its agent checks it), one past its three reviews, or one whose
conversation is busy or has no model gets the agent's words in a "Task done"
notice as before. Failed tasks are not reviewed. The note names the round
("review round 2 of 3"), so the model knows when sending more work is the
last chance.

### Review squads

For a change that is more than trivial, the model may call `task_review`
(task, optional aspects and agent) instead of reviewing everything itself.
It asks the owner to approve a squad: up to three readers (see Readers
below) of the task's worktree, one per aspect, started together. The
aspects are `correctness` and `tests` by default, and `hygiene`, `docs` and
`security` on request; the agent is Codex unless another agent that can read
is named. Always allow covers squads in the same project with the same
agent. A task still at work, a reader, or a task a squad is already
reviewing cannot get one (two approvals decided together start one squad), and the reviewers count toward the task's
sub-task limits.

Each reviewer is told the branch, the task's title, its aspect and the
commit the work began at, reviews committed and uncommitted changes without
changing anything, and reports with `task_result` (see Results below):
`passed`, or `rework` with findings by file and line, most severe first.
A reviewer's own "Task done" notice is not sent.

Once every reviewer has ended, their reports go to the conversation that
asked for the squad rather than to the task's agent, without waiting for the
task's other sub-tasks, whose summary still reaches the task's agent without
the reviewers in it: a turn starts there,
like a review, asking the model to check each finding with `task_diff` and
`task_check`, drop those that do not hold, rank the rest P0 (breaks the
build, loses data, opens a hole) to P3 (nit), and then either send the P0
and P1 findings back to the same task's agent with `task_message`, unless
it is the last round, or tell the owner whether the work is ready to merge.
The owner gets one notice, "Task reviewed by N agents", with the model's
conclusion. When the agent finishes the rework, the next review round
starts as usual, so the loop ends after three rounds. When the conversation
stays busy or has no model, the reports are added to it as a note and sent
as a notice instead. Squads are kept in memory: a squad whose reviewers were
stopped by a restart is not checked.

## Sub-tasks

A task Mob's conversation started may hand parts of its work to other coding
agents, so the tree grows a second level; a sub-task cannot start sub-tasks
of its own. Mob runs an MCP server on loopback (`127.0.0.1`, a random port)
and gives every task's session, when the agent takes MCP servers over HTTP
(`mcpCapabilities.http`), a server named `mob` with a bearer token of its own
that only reaches that task and its sub-tasks. The server is stateless and
checks the token on every request, and the token stops working when the
session ends. Every task gets `task_result` (see Results below); a task that
may start sub-tasks also gets the tools below. Agents that take no HTTP
servers start no sub-tasks and report no result. Its tools:

- `task_start` (title, prompt, optional agent, else the task's own) asks the
  owner to approve, in the task's conversation, as one of the agent's own
  calls: "Start a sub-task: TITLE" with the agent, project and prompt. Such a
  request is never remembered, so Always allow approves it once. The tool
  returns at once, since agents give a tool call little time; once approved,
  the sub-task starts in a new worktree and branch of the same project, with
  the task's conversation as its parent, and the call shows the sub-task's ID
  and branch in the next turn. At most 3 sub-tasks of one task run, wait or are
  starting at once, and 10 in all, checked again when the owner approves.
- With `workspace: shared`, the sub-task is a reader of the task's own
  worktree instead (see Readers below), asked as "Start a read-only
  sub-task"; with no agent named, the task's own, or Codex when the task's
  agent cannot read.
- `tasks` lists the task's sub-tasks: status, agent, title, branch, what they
  used and the end of their latest reply.
- `task_message` and `task_stop` instruct or stop one of them; another
  task's sub-tasks are out of reach.

The agent may also ask its own permission to call these tools, as for any
other MCP tool; that is an approval like any other.

## Readers

A read-only task (`readOnly`, `tasks.read_only`) works in another task's
worktree and branch, seeing its uncommitted changes, without changing them,
such as to review it. It gets no worktree or branch of its own, lends its
worktree to no one, is never reviewed by Mob's model (it changed nothing),
and its card on the Agents page says Read-only. Its agent starts in the
preset's read-only mode: Codex's `read-only`, Claude Agent's and CodeBuddy
Code's `default`, in which they ask before editing; a session that does not
offer that mode fails to start. Mob refuses every edit, delete or move it asks
for without asking the owner, even inside the worktree; its commands are
approvals as usual. DeepSeek Harness has no such mode and cannot be a reader.

## Results

`task_result` (outcome, summary) lets a task's agent say how its work ended:

- `passed`: the work is done and holds up, or what it reviewed needs no
  changes;
- `rework`: the work, or what it reviewed, needs the changes the summary
  lists, most important first;
- `blocked`: it cannot go on without a decision or something it lacks.

Mob keeps the latest (`tasks.outcome`, `tasks.result`, up to 4000
characters of summary) and forgets it when the agent is given more work, so
an outcome always describes the latest work. Any other outcome is refused
with the reason. Summaries and `/tasks` name the outcome after the status
("Done, needs rework"). Summaries also show the reported summary in place of
the end of the agent's last reply; `/tasks` shows only the label. Mob's
`tasks` tool returns both, and the task's card on the Agents page shows them
under the branch.

## Summaries

Once every task a conversation started has ended (done, stopped or failed),
Mob says so in that conversation, once for each set of ended tasks (a task
that ends again after more work makes a new set):

- A task's conversation gets an automatic message listing its sub-tasks with
  their status and outcome, branch, usage and their result or the end of
  their latest reply, so the agent can bring their work in, act on what they
  found and finish its own. An agent at work reads it once
  its prompt ends; one in review gets it as a new prompt; one stopped, failed
  or waiting for a decision is left alone.
- Mob's own conversation, when it started more than one task, gets a note
  "All N tasks started here have ended" with the same list, which is shown
  but never sent to a model (`Store.Note`), and the owner gets it as a
  notice.

## Approvals

- Codex starts each session in its `auto` mode: it edits files and runs
  commands in the worktree without asking, and asks before using the network
  or writing elsewhere. Claude Agent starts in its `acceptEdits` mode: it
  edits files without asking and asks before running commands, so its
  commands are approvals in the task. CodeBuddy Code starts in its
  `acceptEdits` mode too. DeepSeek Harness has no modes: its own
  `workspace-write` sandbox lets it write in the worktree and asks before going
  further, offering only one-time answers. Mob also answers yes, without asking, to any edit,
  delete or move whose files are all inside the task's worktree once links
  are followed, so a link in the repository cannot lead an edit out of it.
- Every other permission the agent asks for is an approval in the task's
  conversation, decided like any other: Approve, Allow in this conversation,
  Always allow, or Deny with an optional reason, from any client. Allow and
  Always allow are remembered as grants for the call's tool name and title,
  and the agent is answered with its own "always" option. DeepSeek Harness
  and CodeBuddy Code send requests that name only the call they showed
  before; theirs are remembered for that call's title with its whole input,
  so remembering one command never allows another. A request with neither a
  title nor an input is allowed that once but never remembered.
- Unlike a model's tool call, the agent keeps waiting while an approval is
  pending. The turn that asked ends, and the decision starts a turn that
  follows the agent on; the approved call shows how it ended there. A denial with
  a reason cancels the agent's current prompt and sends the reason as its
  next one, so it does not work around the denial without knowing why.
- Writing to the task instead of deciding denies what waits and sends the
  message after the agent has dealt with the denial.
- An approval left for an hour expires, and the agent is told it was
  cancelled.

## Notices

When a task's turn ends waiting for an approval, done (unless Mob reviews it,
above) or failed, Mob raises a
`chat.Notice` (`ConversationService.Notify`): the task's agent and title, the
agent's last words (up to 1200 characters), its branch and what it used when
done, the error
when failed or stopped early (such as at the agent's limit, with how to
continue), and the approvals that wait. Stopping a task, even while its agent
is starting, raises none and leaves it stopped.
Messaging channels pass notices on; [Telegram](channels.md) sends them with
approval buttons, so the owner can follow and decide tasks from the phone. A
turn started from a channel, such as a decision tapped there, sends that
channel no notice, since its reply already says how the turn ended.

## Usage

What a task's agent used is recorded with Mob's own
[token usage](turns-and-context.md#token-usage) when each of its prompts ends,
so `/usage` in the task's conversation, the `Used` column of `/tasks`, the
`tasks` tool and the done notice show it.

- An agent that reports a prompt's usage in its response (ACP's unstable
  `usage`) is recorded as it says. Claude Agent does, with cache reads and
  writes, and its `_meta.quota.model_usage` splits it by model. Input is
  counted with the cache, as for Mob's own models; an agent whose total adds
  the cache to its input, as Claude Agent's does, is counted that way.
- Claude Agent also reports what its run has cost so far (`usage_update`);
  what it added since the last prompt is recorded as that prompt's cost.
- Codex (`codex-acp` 0.16) reports no tokens over ACP. Its ACP session is a
  Codex thread of the same ID, so Mob reads the thread's rollout file
  (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl`, `CODEX_HOME`
  defaulting to `~/.codex`): the last `token_count` total, less what the task
  already recorded for that session, is the prompt's (a session that replaces
  one that could not be loaded counts from zero, and the old one's usage
  stays), under the model of the last
  `turn_context`. Codex reports no cost.
- An agent that reports neither shows no usage, and a prompt stopped from
  Mob may record none. The code is in `apps/mob/src/agents/usage.ts`.

## Lifetime

- An agent process starts with the first turn that needs it and runs until the
  task is stopped, Mob stops, or, for a sub-task, its report is delivered
  (below); it runs in a process group of its own (a process tree on
  Windows), so what `npx` starts ends with it. Stopping a turn cancels the
  agent's prompt; an agent that does not end it within ten seconds is ended.
- Sub-task agents are reaped once their reports are delivered: when a task
  and all its sub-tasks have ended (after it hears how they went and ends its
  own turn, or is stopped, or its last sub-task ends after it stopped or
  failed), the agents of its ended sub-tasks end; a squad's
  reviewers end once all of them have ended and their reports are gathered.
  The task's own agent stays, and so do the sub-tasks' worktrees, branches
  and conversations. A message to a reaped sub-task starts its agent again,
  loading or resuming its session where the agent can.
- When Mob starts, tasks still marked running or waiting are marked stopped:
  their agents ended with Mob. Deciding an approval no agent waits for any
  more starts nothing; the call is marked failed and the reply says to send
  the task a message to continue.
- When Mob starts an agent for a task that already has a session, it loads that
  session (Codex, Claude Agent and CodeBuddy Code support this), so the agent remembers the work; the history
  the agent replays while loading is not shown again. An agent that cannot
  load sessions but can resume them, as DeepSeek Harness, resumes it instead,
  without a replay.
- Delegated conversations reuse `ConversationService`: `SetDelegate` hands the
  turns of the conversations a `chat.Delegate` owns to it instead of the model
  loop, and `chat.DelegateTurn` writes and saves the reply as the engine does.

## Project forms

**Agents → Manage projects** opens Web's **Manage Mob → Projects**. Add a
repository using its absolute path on the connected Mob (spaces are supported),
choose a blueprint, and edit checks as an ordered list of commands. Each check
may contain multiple lines. Saving checks authorizes their automatic execution
in finished tasks' worktrees; the form explains this before saving. Removing a
project requires confirmation and keeps its tasks, branches and worktrees.
The form and `/projects` use the same project service and blueprint validation.
Adding an already-saved name or repository path in the form reports an error;
it does not rename or replace the existing project.

Telegram's `/tasks [PROJECT]` and **More → Tasks** show paged task summaries.
Selecting a task switches to its conversation; the list does not execute task
configuration changes.
