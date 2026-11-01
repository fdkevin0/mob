# Task workflow

What happens to a [coding agent](coding-agents.md) task between the agent's
first prompt and the owner's review: the blueprint that checks and reviews
it, the sub-tasks and read-only reviewers it may start, how agents report
results, and how long their processes live.

## Blueprints

A blueprint is how a task Mob's model started goes from the agent's finished
work to ready to review. Mob runs it itself, step by step, so the checks, the
review and the rounds of rework do not depend on a model remembering them.
Sub-tasks and readers have none: their parent task's agent checks them.

| Blueprint | After the agent's work |
| --- | --- |
| `standard` (the default) | the project's checks, then a review of correctness and tests by another agent |
| `quick` | the project's checks |
| `manual` | Mob's model checks the work as it sees fit (see [Reviewing finished work](#reviewing-finished-work)) |

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

**Review** starts a review squad (see [Review squads](#review-squads)) of another agent
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
It asks the owner to approve a squad: up to three readers (see [Readers](#readers)) of the task's worktree, one per aspect, started together. The
aspects are `correctness` and `tests` by default, and `hygiene`, `docs` and
`security` on request; the agent is Codex unless another agent that can read
is named. Always allow covers squads in the same project with the same
agent. A task still at work, a reader, or a task a squad is already
reviewing cannot get one (two approvals decided together start one squad), and the reviewers count toward the task's
sub-task limits.

Each reviewer is told the branch, the task's title, its aspect and the
commit the work began at, reviews committed and uncommitted changes without
changing anything, and reports with `task_result` (see [Results](#results)):
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
session ends. Every task gets `task_result` (see [Results](#results)); a task that
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
  worktree instead (see [Readers](#readers)), asked as "Start a read-only
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
and its card on the Agents page says Read-only. Codex starts with its
`read-only` sandbox, which cannot write at all; when it asks for more
permissions, Mob drops any write access from the request, asks only about
the rest, and refuses outright when nothing else is left. An ACP agent starts in its
preset's read-only mode, Claude Agent's and CodeBuddy Code's `default`, in
which they ask before editing; a session that does not offer that mode fails
to start. Mob refuses every edit, delete or move it asks
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
  but never sent to a model (`store.note`), and the owner gets it as a
  notice.

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
- Delegated conversations reuse `ConversationService`: `setDelegate` hands the
  turns of the conversations a `Delegate` (`packages/core/src/chat/delegate.ts`)
  owns to it instead of the model loop, and `DelegateTurn` writes and saves the
  reply as the engine does.

